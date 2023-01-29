import type { SerializableProvider } from "@trigger.dev/providers";

export function IntegrationIcon({
  integration,
}: {
  integration: SerializableProvider;
}) {
  return (
    <img
      src={integration.icon}
      alt={integration.name}
      className="h-5 w-5 shadow-lg group-hover:opacity-80 transition"
    />
  );
}
