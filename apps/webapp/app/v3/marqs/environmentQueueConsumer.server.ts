import { Context, ROOT_CONTEXT, Span, SpanKind, context, trace } from "@opentelemetry/api";
import {
  RetryOptions,
  TaskRunContext,
  TaskRunExecution,
  TaskRunExecutionResult,
  ZodMessageSender,
  defaultRetryOptions,
  flattenAttributes,
  serverWebsocketMessages,
} from "@trigger.dev/core/v3";
import { BackgroundWorker, BackgroundWorkerTask } from "@trigger.dev/database";
import { z } from "zod";
import { prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { marqs } from "../marqs.server";
import { attributesFromAuthenticatedEnv } from "../tracer.server";
import { eventRepository } from "../eventRepository.server";

const tracer = trace.getTracer("environmentQueueConsumer");

const MessageBody = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("EXECUTE"),
    taskIdentifier: z.string(),
  }),
]);

type BackgroundWorkerWithTasks = BackgroundWorker & { tasks: BackgroundWorkerTask[] };

export type EnvironmentQueueConsumerOptions = {
  maximumItemsPerTrace?: number;
  traceTimeoutSeconds?: number;
};

export class EnvironmentQueueConsumer {
  private _backgroundWorkers: Map<string, BackgroundWorkerWithTasks> = new Map();
  private _enabled = false;
  private _options: Required<EnvironmentQueueConsumerOptions>;
  private _perTraceCountdown: number | undefined;
  private _lastNewTrace: Date | undefined;
  private _currentSpanContext: Context | undefined;
  private _taskFailures: number = 0;
  private _taskSuccesses: number = 0;
  private _currentSpan: Span | undefined;
  private _endSpanInNextIteration = false;

  constructor(
    public env: AuthenticatedEnvironment,
    private _sender: ZodMessageSender<typeof serverWebsocketMessages>,
    options: EnvironmentQueueConsumerOptions = {}
  ) {
    this._options = {
      maximumItemsPerTrace: options.maximumItemsPerTrace ?? 1_000, // 1k items per trace
      traceTimeoutSeconds: options.traceTimeoutSeconds ?? 60, // 60 seconds
    };
  }

  public async registerBackgroundWorker(id: string) {
    const backgroundWorker = await prisma.backgroundWorker.findUnique({
      where: { friendlyId: id, runtimeEnvironmentId: this.env.id },
      include: {
        tasks: true,
      },
    });

    if (!backgroundWorker) {
      return;
    }

    this._backgroundWorkers.set(backgroundWorker.id, backgroundWorker);

    logger.debug("Registered background worker", { backgroundWorker: backgroundWorker.id });

    // Start reading from the queue if we haven't already
    this.#enable();
  }

  public async taskRunCompleted(
    workerId: string,
    completion: TaskRunExecutionResult,
    execution: TaskRunExecution
  ) {
    logger.debug("Task run completed", { taskRunCompletion: completion, execution });

    const taskRunAttempt = completion.ok
      ? await prisma.taskRunAttempt.update({
          where: { friendlyId: completion.id },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            output: completion.output,
            outputType: completion.outputType,
          },
          include: {
            taskRun: true,
            backgroundWorkerTask: true,
          },
        })
      : await prisma.taskRunAttempt.update({
          where: { friendlyId: completion.id },
          data: {
            status: "FAILED",
            completedAt: new Date(),
            error: completion.error,
          },
          include: {
            taskRun: true,
            backgroundWorkerTask: true,
          },
        });

    if (taskRunAttempt.status === "COMPLETED") {
      this._taskSuccesses++;
    } else {
      this._taskFailures++;
    }

    if (!completion.ok && completion.retry !== undefined) {
      const retryConfig = taskRunAttempt.backgroundWorkerTask.retryConfig
        ? {
            ...defaultRetryOptions,
            ...RetryOptions.parse(taskRunAttempt.backgroundWorkerTask.retryConfig),
          }
        : undefined;

      const retryAt = new Date(completion.retry.timestamp);
      // Retry the task run
      await eventRepository.recordEvent(
        retryConfig?.maxAttempts
          ? `Retry ${execution.attempt.number}/${retryConfig?.maxAttempts - 1} delay`
          : `Retry #${execution.attempt.number} delay`,
        {
          taskSlug: taskRunAttempt.taskRun.taskIdentifier,
          environment: this.env,
          attributes: {
            metadata: this.#generateMetadataAttributesForNextAttempt(execution),
            properties: {
              retryAt: retryAt.toISOString(),
              factor: retryConfig?.factor,
              maxAttempts: retryConfig?.maxAttempts,
              minTimeoutInMs: retryConfig?.minTimeoutInMs,
              maxTimeoutInMs: retryConfig?.maxTimeoutInMs,
              randomize: retryConfig?.randomize,
            },
            runId: taskRunAttempt.taskRunId,
            style: {
              icon: "schedule-attempt",
            },
            queueId: taskRunAttempt.queueId,
            queueName: taskRunAttempt.taskRun.queue,
          },
          context: taskRunAttempt.taskRun.traceContext as Record<string, string | undefined>,
          spanIdSeed: `retry-${taskRunAttempt.number + 1}`,
          endTime: retryAt,
        }
      );

      await marqs?.nackMessage(taskRunAttempt.taskRunId, completion.retry.timestamp);
    } else {
      await marqs?.acknowledgeMessage(taskRunAttempt.taskRunId);
    }
  }

  #generateMetadataAttributesForNextAttempt(execution: TaskRunExecution) {
    const context = TaskRunContext.parse(execution);

    // @ts-ignore
    context.attempt = {
      number: context.attempt.number + 1,
    };

    return flattenAttributes(context, "ctx");
  }

  public async taskHeartbeat(workerId: string, id: string, seconds: number = 60) {
    const taskRunAttempt = await prisma.taskRunAttempt.findUnique({
      where: { friendlyId: id },
    });

    if (!taskRunAttempt) {
      return;
    }

    await marqs?.heartbeatMessage(taskRunAttempt.taskRunId, seconds);
  }

  public async stop() {
    this._enabled = false;
  }

  #enable() {
    if (this._enabled) {
      return;
    }

    this._enabled = true;
    this._perTraceCountdown = this._options.maximumItemsPerTrace;
    this._lastNewTrace = new Date();
    this._taskFailures = 0;
    this._taskSuccesses = 0;

    this.#doWork().finally(() => {});
  }

  async #doWork() {
    if (!this._enabled) {
      return;
    }

    // Check if the trace has expired
    if (
      this._perTraceCountdown === 0 ||
      Date.now() - this._lastNewTrace!.getTime() > this._options.traceTimeoutSeconds * 1000 ||
      this._currentSpanContext === undefined ||
      this._endSpanInNextIteration
    ) {
      if (this._currentSpan) {
        this._currentSpan.setAttribute("tasks.period.failures", this._taskFailures);
        this._currentSpan.setAttribute("tasks.period.successes", this._taskSuccesses);

        this._currentSpan.end();
      }

      // Create a new trace
      this._currentSpan = tracer.startSpan(
        "EnvironmentQueueConsumer.doWork()",
        {
          kind: SpanKind.CONSUMER,
          attributes: {
            ...attributesFromAuthenticatedEnv(this.env),
          },
        },
        ROOT_CONTEXT
      );

      // Get the span trace context
      this._currentSpanContext = trace.setSpan(ROOT_CONTEXT, this._currentSpan);

      this._perTraceCountdown = this._options.maximumItemsPerTrace;
      this._lastNewTrace = new Date();
      this._taskFailures = 0;
      this._taskSuccesses = 0;
      this._endSpanInNextIteration = false;
    }

    return context.with(this._currentSpanContext ?? ROOT_CONTEXT, async () => {
      await this.#doWorkInternal();
      this._perTraceCountdown = this._perTraceCountdown! - 1;
    });
  }

  async #doWorkInternal() {
    // Attempt to dequeue a message from the environment's queue
    // If no message is available, reschedule the worker to run again in 1 second
    // If a message is available, find the BackgroundWorkerTask that matches the message's taskIdentifier
    // If no matching task is found, nack the message and reschedule the worker to run again in 1 second
    // If the matching task is found, create the task attempt and lock the task run, then send the task run to the client
    // Store the message as a processing message
    // If the websocket connection disconnects before the task run is completed, nack the message
    // When the task run completes, ack the message
    // Using a heartbeat mechanism, if the client keeps responding with a heartbeat, we'll keep the message processing and increase the visibility timeout.

    const message = await marqs?.dequeueMessageInEnv(this.env);

    if (!message) {
      setTimeout(() => this.#doWork(), 1000);
      return;
    }

    const messageBody = MessageBody.safeParse(message.data);

    if (!messageBody.success) {
      logger.error("Failed to parse message", {
        queueMessage: message.data,
        error: messageBody.error,
        env: this.env,
      });

      await marqs?.acknowledgeMessage(message.messageId);

      setTimeout(() => this.#doWork(), 100);
      return;
    }

    const existingTaskRun = await prisma.taskRun.findUnique({
      where: {
        id: message.messageId,
      },
    });

    if (!existingTaskRun) {
      await marqs?.acknowledgeMessage(message.messageId);
      setTimeout(() => this.#doWork(), 100);
      return;
    }

    const backgroundWorker = existingTaskRun.lockedToVersionId
      ? this._backgroundWorkers.get(existingTaskRun.lockedToVersionId)
      : this.#getLatestBackgroundWorker();

    if (!backgroundWorker) {
      await marqs?.acknowledgeMessage(message.messageId);
      setTimeout(() => this.#doWork(), 100);
      return;
    }

    const backgroundTask = backgroundWorker.tasks.find(
      (task) => task.slug === existingTaskRun.taskIdentifier
    );

    if (!backgroundTask) {
      logger.warn("No matching background task found for task run", {
        taskRun: existingTaskRun.id,
        taskIdentifier: existingTaskRun.taskIdentifier,
        backgroundWorker: backgroundWorker.id,
        taskSlugs: backgroundWorker.tasks.map((task) => task.slug),
      });

      await marqs?.acknowledgeMessage(message.messageId);

      setTimeout(() => this.#doWork(), 100);
      return;
    }

    const lockedTaskRun = await prisma.taskRun.update({
      where: {
        id: message.messageId,
      },
      data: {
        lockedAt: new Date(),
        lockedById: backgroundTask.id,
      },
      include: {
        attempts: {
          take: 1,
          orderBy: { number: "desc" },
        },
        tags: true,
      },
    });

    if (!lockedTaskRun) {
      logger.warn("Failed to lock task run", {
        taskRun: existingTaskRun.id,
        taskIdentifier: existingTaskRun.taskIdentifier,
        backgroundWorker: backgroundWorker.id,
        messageId: message.messageId,
      });

      await marqs?.acknowledgeMessage(message.messageId);

      setTimeout(() => this.#doWork(), 100);
      return;
    }

    const queue = await prisma.taskQueue.findUnique({
      where: {
        runtimeEnvironmentId_name: { runtimeEnvironmentId: this.env.id, name: lockedTaskRun.queue },
      },
    });

    if (!queue) {
      await marqs?.nackMessage(message.messageId);
      setTimeout(() => this.#doWork(), 1000);
      return;
    }

    if (!this._enabled) {
      await marqs?.nackMessage(message.messageId);
      return;
    }

    const taskRunAttempt = await prisma.taskRunAttempt.create({
      data: {
        number: lockedTaskRun.attempts[0] ? lockedTaskRun.attempts[0].number + 1 : 1,
        friendlyId: generateFriendlyId("attempt"),
        taskRunId: lockedTaskRun.id,
        startedAt: new Date(),
        backgroundWorkerId: backgroundTask.workerId,
        backgroundWorkerTaskId: backgroundTask.id,
        status: "EXECUTING" as const,
        queueId: queue.id,
      },
    });

    const execution = {
      task: {
        id: backgroundTask.slug,
        filePath: backgroundTask.filePath,
        exportName: backgroundTask.exportName,
      },
      attempt: {
        id: taskRunAttempt.friendlyId,
        number: taskRunAttempt.number,
        startedAt: taskRunAttempt.startedAt ?? taskRunAttempt.createdAt,
        backgroundWorkerId: backgroundWorker.id,
        backgroundWorkerTaskId: backgroundTask.id,
        status: "EXECUTING" as const,
      },
      run: {
        id: lockedTaskRun.friendlyId,
        payload: lockedTaskRun.payload,
        payloadType: lockedTaskRun.payloadType,
        context: lockedTaskRun.context,
        createdAt: lockedTaskRun.createdAt,
        tags: lockedTaskRun.tags.map((tag) => tag.name),
      },
      queue: {
        id: queue.friendlyId,
        name: queue.name,
      },
      environment: {
        id: this.env.id,
        slug: this.env.slug,
        type: this.env.type,
      },
      organization: {
        id: this.env.organization.id,
        slug: this.env.organization.slug,
        name: this.env.organization.title,
      },
      project: {
        id: this.env.project.id,
        ref: this.env.project.externalRef,
        slug: this.env.project.slug,
        name: this.env.project.name,
      },
    };

    const payload = {
      execution,
      traceContext: lockedTaskRun.traceContext as Record<string, unknown>,
    };

    try {
      // TODO: send trace context down to the CLI
      await this._sender.send("BACKGROUND_WORKER_MESSAGE", {
        backgroundWorkerId: backgroundWorker.friendlyId,
        data: {
          type: "EXECUTE_RUNS",
          payloads: [payload],
        },
      });
    } catch (e) {
      if (e instanceof Error) {
        this._currentSpan?.recordException(e);
      } else {
        this._currentSpan?.recordException(new Error(String(e)));
      }

      this._endSpanInNextIteration = true;

      // We now need to unlock the task run and delete the task run attempt
      await prisma.$transaction([
        prisma.taskRun.update({
          where: {
            id: lockedTaskRun.id,
          },
          data: {
            lockedAt: null,
            lockedById: null,
          },
        }),
        prisma.taskRunAttempt.delete({
          where: {
            id: taskRunAttempt.id,
          },
        }),
      ]);

      // Finally we need to nack the message so it can be retried
      await marqs?.nackMessage(message.messageId);
    } finally {
      setTimeout(() => this.#doWork(), 100);
    }
  }

  // Get the latest background worker based on the version.
  // Versions are in the format of 20240101.1 and 20240101.2
  #getLatestBackgroundWorker() {
    const workers = Array.from(this._backgroundWorkers.values());

    if (workers.length === 0) {
      return;
    }

    return workers.reduce((acc, curr) => {
      if (acc.version > curr.version) {
        return acc;
      }

      return curr;
    });
  }
}
