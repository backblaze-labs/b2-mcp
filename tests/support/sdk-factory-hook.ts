import type { B2Client as SdkB2Client, UrlGuard } from "@backblaze-labs/b2-sdk";
import type { B2Config } from "../../src/utils/types";

interface ManagedSdkClient {
  client: SdkB2Client;
  urlGuard?: UrlGuard;
}

type SdkClientFactory = (config: B2Config) => ManagedSdkClient;
const SDK_CLIENT_FACTORY_HOOK = Symbol.for("@backblaze-labs/b2-mcp/sdk-client-factory");

type SdkClientFactoryHook = {
  [SDK_CLIENT_FACTORY_HOOK]?: SdkClientFactory;
};

export function setB2SdkClientFactoryForTests(factory: SdkClientFactory | null): void {
  const target = globalThis as typeof globalThis & SdkClientFactoryHook;
  if (factory) target[SDK_CLIENT_FACTORY_HOOK] = factory;
  else delete target[SDK_CLIENT_FACTORY_HOOK];
}
