import { Prisma, TaskEventStatus, type TaskEventKind } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { RandomIdGenerator } from "@opentelemetry/sdk-trace-base";
import { Attributes, ROOT_CONTEXT, propagation, trace } from "@opentelemetry/api";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { SemanticInternalAttributes, PRIMARY_VARIANT } from "@trigger.dev/core/v3";
import { flattenAttributes } from "@trigger.dev/core/v3";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { DynamicFlushScheduler } from "./dynamicFlushScheduler.server";
import { logger } from "~/services/logger.server";
import { createHash } from "node:crypto";

export type CreatableEvent = Omit<
  Prisma.TaskEventCreateInput,
  "id" | "createdAt" | "properties" | "metadata" | "style" | "output"
> & {
  properties: Attributes;
  metadata: Attributes | undefined;
  style: Attributes | undefined;
  output: Attributes | undefined;
};

export type CreatableEventKind = TaskEventKind;
export type CreatableEventStatus = TaskEventStatus;
export type CreatableEventEnvironmentType = CreatableEvent["environmentType"];

export type TraceAttributes = Partial<
  Pick<
    CreatableEvent,
    | "attemptId"
    | "isError"
    | "runId"
    | "output"
    | "metadata"
    | "properties"
    | "style"
    | "queueId"
    | "queueName"
  >
>;

export type SetAttribute<T extends TraceAttributes> = (key: keyof T, value: T[keyof T]) => void;

export type TraceEventOptions = {
  kind?: CreatableEventKind;
  context?: Record<string, string | undefined>;
  spanIdSeed?: string;
  attributes: TraceAttributes;
  environment: AuthenticatedEnvironment;
  taskSlug: string;
  startTime?: Date;
  endTime?: Date;
};

export type EventBuilder = {
  traceId: string;
  spanId: string;
  setAttribute: SetAttribute<TraceAttributes>;
};

export type EventRepoConfig = {
  batchSize: number;
  batchInterval: number;
};

export class EventRepository {
  private readonly _flushScheduler: DynamicFlushScheduler<CreatableEvent>;

  private _randomIdGenerator = new RandomIdGenerator();

  constructor(private db: PrismaClient = prisma, private readonly _config: EventRepoConfig) {
    this._flushScheduler = new DynamicFlushScheduler({
      batchSize: _config.batchSize,
      flushInterval: _config.batchInterval,
      callback: this.#flushBatch.bind(this),
    });
  }

  async insert(event: CreatableEvent) {
    this._flushScheduler.addToBatch([event]);
  }

  async insertMany(events: CreatableEvent[]) {
    this._flushScheduler.addToBatch(events);
  }

  public async recordEvent(message: string, options: TraceEventOptions) {
    const propagatedContext = extractContextFromCarrier(options.context ?? {});

    const startTime = options.startTime ?? new Date();
    const durationInMs = options.endTime ? options.endTime.getTime() - startTime.getTime() : 100;

    const traceId = propagatedContext?.traceparent?.traceId ?? this.generateTraceId();
    const parentId = propagatedContext?.traceparent?.spanId;
    const tracestate = propagatedContext?.tracestate;
    const spanId = options.spanIdSeed
      ? this.#generateDeterministicSpanId(traceId, options.spanIdSeed)
      : this.generateSpanId();

    const metadata = {
      [SemanticInternalAttributes.ENVIRONMENT_ID]: options.environment.id,
      [SemanticInternalAttributes.ENVIRONMENT_TYPE]: options.environment.type,
      [SemanticInternalAttributes.ORGANIZATION_ID]: options.environment.organizationId,
      [SemanticInternalAttributes.PROJECT_ID]: options.environment.projectId,
      [SemanticInternalAttributes.PROJECT_REF]: options.environment.project.externalRef,
      [SemanticInternalAttributes.RUN_ID]: options.attributes.runId,
      [SemanticInternalAttributes.TASK_SLUG]: options.taskSlug,
      [SemanticResourceAttributes.SERVICE_NAME]: "api server",
      [SemanticResourceAttributes.SERVICE_NAMESPACE]: "trigger.dev",
      ...options.attributes.metadata,
    };

    const style = {
      [SemanticInternalAttributes.STYLE_ICON]: "play",
    };

    if (!options.attributes.runId) {
      throw new Error("runId is required");
    }

    const event: CreatableEvent = {
      traceId,
      spanId,
      parentId,
      tracestate,
      message: message,
      serviceName: "api server",
      serviceNamespace: "trigger.dev",
      level: "TRACE",
      kind: options.kind,
      status: "OK",
      startTime,
      isPartial: false,
      duration: durationInMs * 1_000_000, // convert to nanoseconds
      environmentId: options.environment.id,
      environmentType: options.environment.type,
      organizationId: options.environment.organizationId,
      projectId: options.environment.projectId,
      projectRef: options.environment.project.externalRef,
      runId: options.attributes.runId,
      taskSlug: options.taskSlug,
      queueId: options.attributes.queueId,
      queueName: options.attributes.queueName,
      properties: {
        ...style,
        ...(flattenAttributes(metadata, SemanticInternalAttributes.METADATA) as Record<
          string,
          string
        >),
        ...options.attributes.properties,
      },
      metadata: metadata,
      style: stripAttributePrefix(style, SemanticInternalAttributes.STYLE),
      output: undefined,
    };

    this._flushScheduler.addToBatch([event]);

    return event;
  }

  public async traceEvent<TResult>(
    message: string,
    options: TraceEventOptions,
    callback: (
      e: EventBuilder,
      traceContext: Record<string, string | undefined>
    ) => Promise<TResult>
  ): Promise<TResult> {
    const propagatedContext = extractContextFromCarrier(options.context ?? {});

    const start = process.hrtime.bigint();
    const startTime = new Date();

    const traceId = propagatedContext?.traceparent?.traceId ?? this.generateTraceId();
    const parentId = propagatedContext?.traceparent?.spanId;
    const tracestate = propagatedContext?.tracestate;
    const spanId = options.spanIdSeed
      ? this.#generateDeterministicSpanId(traceId, options.spanIdSeed)
      : this.generateSpanId();

    logger.info("traceEvent", {
      traceId,
      parentId,
      tracestate,
      spanId,
      context: options.context,
      propagatedContext,
    });

    const traceContext = {
      traceparent: `00-${traceId}-${spanId}-01`,
    };

    const eventBuilder = {
      traceId,
      spanId,
      setAttribute: (key: keyof TraceAttributes, value: TraceAttributes[keyof TraceAttributes]) => {
        if (value) {
          // We need to merge the attributes with the existing attributes
          const existingValue = options.attributes[key];

          if (existingValue && typeof existingValue === "object" && typeof value === "object") {
            // @ts-ignore
            options.attributes[key] = { ...existingValue, ...value };
          } else {
            // @ts-ignore
            options.attributes[key] = value;
          }
        }
      },
    };

    const result = await callback(eventBuilder, traceContext);

    const duration = process.hrtime.bigint() - start;

    const metadata = {
      [SemanticInternalAttributes.ENVIRONMENT_ID]: options.environment.id,
      [SemanticInternalAttributes.ENVIRONMENT_TYPE]: options.environment.type,
      [SemanticInternalAttributes.ORGANIZATION_ID]: options.environment.organizationId,
      [SemanticInternalAttributes.PROJECT_ID]: options.environment.projectId,
      [SemanticInternalAttributes.PROJECT_REF]: options.environment.project.externalRef,
      [SemanticInternalAttributes.RUN_ID]: options.attributes.runId,
      [SemanticInternalAttributes.TASK_SLUG]: options.taskSlug,
      [SemanticResourceAttributes.SERVICE_NAME]: "api server",
      [SemanticResourceAttributes.SERVICE_NAMESPACE]: "trigger.dev",
      ...options.attributes.metadata,
    };

    const style = {
      [SemanticInternalAttributes.STYLE_ICON]: "task",
      [SemanticInternalAttributes.STYLE_VARIANT]: PRIMARY_VARIANT,
    };

    if (!options.attributes.runId) {
      throw new Error("runId is required");
    }

    const event: CreatableEvent = {
      traceId,
      spanId,
      parentId,
      tracestate,
      duration: duration,
      message: message,
      serviceName: "api server",
      serviceNamespace: "trigger.dev",
      level: "TRACE",
      kind: options.kind,
      status: "OK",
      startTime: startTime,
      environmentId: options.environment.id,
      environmentType: options.environment.type,
      organizationId: options.environment.organizationId,
      projectId: options.environment.projectId,
      projectRef: options.environment.project.externalRef,
      runId: options.attributes.runId,
      taskSlug: options.taskSlug,
      queueId: options.attributes.queueId,
      queueName: options.attributes.queueName,
      properties: {
        ...style,
        ...(flattenAttributes(metadata, SemanticInternalAttributes.METADATA) as Record<
          string,
          string
        >),
      },
      metadata: metadata,
      style: stripAttributePrefix(style, SemanticInternalAttributes.STYLE),
      output: undefined,
    };

    this._flushScheduler.addToBatch([event]);

    return result;
  }

  async #flushBatch(batch: CreatableEvent[]) {
    const events = excludePartialEventsWithCorrespondingFullEvent(batch);

    await this.db.taskEvent.createMany({
      data: events as Prisma.TaskEventCreateManyInput[],
    });
  }

  public generateTraceId() {
    return this._randomIdGenerator.generateTraceId();
  }

  public generateSpanId() {
    return this._randomIdGenerator.generateSpanId();
  }

  /**
   * Returns a deterministically random 8-byte span ID formatted/encoded as a 16 lowercase hex
   * characters corresponding to 64 bits, based on the trace ID and seed.
   */
  #generateDeterministicSpanId(traceId: string, seed: string) {
    const hash = createHash("sha1");
    hash.update(traceId);
    hash.update(seed);
    const buffer = hash.digest();
    let hexString = "";
    for (let i = 0; i < 8; i++) {
      const val = buffer.readUInt8(i);
      const str = val.toString(16).padStart(2, "0");
      hexString += str;
    }
    return hexString;
  }
}

export const eventRepository = new EventRepository(prisma, {
  batchSize: 100,
  batchInterval: 5000,
});

export function stripAttributePrefix(attributes: Attributes, prefix: string) {
  const result: Attributes = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length + 1)] = value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Filters out partial events from a batch of creatable events, excluding those that have a corresponding full event.
 * @param batch - The batch of creatable events to filter.
 * @returns The filtered array of creatable events, excluding partial events with corresponding full events.
 */
function excludePartialEventsWithCorrespondingFullEvent(batch: CreatableEvent[]): CreatableEvent[] {
  const partialEvents = batch.filter((event) => event.isPartial);
  const fullEvents = batch.filter((event) => !event.isPartial);

  return fullEvents.concat(
    partialEvents.filter((partialEvent) => {
      return !fullEvents.some((fullEvent) => fullEvent.spanId === partialEvent.spanId);
    })
  );
}

function extractContextFromCarrier(carrier: Record<string, string | undefined>) {
  const traceparent = carrier["traceparent"];
  const tracestate = carrier["tracestate"];

  return {
    traceparent: parseTraceparent(traceparent),
    tracestate,
  };
}

function parseTraceparent(traceparent?: string): { traceId: string; spanId: string } | undefined {
  if (!traceparent) {
    return undefined;
  }

  const parts = traceparent.split("-");

  if (parts.length !== 4) {
    return undefined;
  }

  const [version, traceId, spanId, flags] = parts;

  if (version !== "00") {
    return undefined;
  }

  return { traceId, spanId };
}

const SHARED_CHAR_CODES_ARRAY = Array(32);
function getIdGenerator(bytes: number): () => string {
  return function generateId() {
    for (let i = 0; i < bytes * 2; i++) {
      SHARED_CHAR_CODES_ARRAY[i] = Math.floor(Math.random() * 16) + 48;
      // valid hex characters in the range 48-57 and 97-102
      if (SHARED_CHAR_CODES_ARRAY[i] >= 58) {
        SHARED_CHAR_CODES_ARRAY[i] += 39;
      }
    }
    return String.fromCharCode.apply(null, SHARED_CHAR_CODES_ARRAY.slice(0, bytes * 2));
  };
}
