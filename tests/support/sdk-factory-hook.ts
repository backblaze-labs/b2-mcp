import { setB2SdkClientFactoryForTests as setSourceB2SdkClientFactoryForTests } from "../../src/auth";
import { setB2PartnerClientFactoryForTests } from "../../src/b2/client";

const REMOVED_SDK_CLIENT_FACTORY_HOOK = Symbol.for("@backblaze-labs/b2-mcp/sdk-client-factory");

export function restoreB2SdkTransportForTests(): void {
  setSourceB2SdkClientFactoryForTests(null);
  setB2PartnerClientFactoryForTests(null);
  delete (globalThis as Record<PropertyKey, unknown>)[REMOVED_SDK_CLIENT_FACTORY_HOOK];
}

export function setB2SdkClientFactoryForTests(
  factory: Parameters<typeof setSourceB2SdkClientFactoryForTests>[0],
): void {
  restoreB2SdkTransportForTests();
  setSourceB2SdkClientFactoryForTests(factory);
}
