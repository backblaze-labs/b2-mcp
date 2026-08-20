declare module "*.mjs" {
  export function verifyNpmRegistryMetadata(
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}
