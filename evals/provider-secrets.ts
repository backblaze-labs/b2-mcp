import { ANTHROPIC_API_KEY_ENV } from "./anthropic-driver";
import { OPENAI_API_KEY_ENV } from "./openai-driver";

export const PROVIDER_SECRET_ENV_NAMES = [ANTHROPIC_API_KEY_ENV, OPENAI_API_KEY_ENV] as const;

export function providerSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return PROVIDER_SECRET_ENV_NAMES.map((name) => env[name]).filter((value): value is string =>
    Boolean(value),
  );
}
