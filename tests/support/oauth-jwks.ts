/* cspell:disable */
import {
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  sign as nodeSign,
  type JsonWebKey,
} from "node:crypto";
import { introspectionClaims } from "./oauth-introspection";

const rsaPrivateJwk = {
  kty: "RSA",
  n: "pFW3ni6ZrJmRFlXFVaSgTKa18nbzaUZ1O1McAgPosEdrxBKp_j5_l34oGXiA2h-zdr78a1aXhsmIk0mNW_N-D6wCC56yCYVsEjgLEhId-zmrpKd9tcSn5uDWLR5EYrkFbN9qSb2En7Sdvh2xziG2JsL8pu20UufHVGQF5VJ7__wsGl7fPuEalGmadbDobs7XeN7iu_YQjTuHp0FE5nSsTUJkWmSNEgJ4YgrdCa-yv0-S4szRdQNSTUtKFcY7SIHbzlkaEK3TEW-hHDXlc1eI9QEG7ZIjp9QBi7bKvTe5m3Yi4EAUiKHyC-Di9cXUPQl1vfBtPVSfCQLBgxBXqHvSDQ",
  e: "AQAB",
  d: "BjFxdJAmsXcDcpcz6Hjbo601YS2zbwMSlZ7vCMe97rAaXcQi95ZtDOKvvy9SknssXRbF1i5oEn0o3P13dYDVKOEKHgb9MwJTYtJi3xZOCUg7RulwVuJ86LoOHZrXkpg3c0rDgNjtam648nprAizfZlGQik1Ir5vVisF5lBK04p4-QT-iKORUsxUd61FUfGlgUluzFsNel_Sowj5cArwCLqr5F1sP7izSKy5CnJ6WDYsoWUqWoUeR3nIuZxHbJuJSnn7aZ_AoTTsRuEXy9T8Q88iv-w88HePDDc-GbLvjElr9GXKFwA2Se7JrulYNpAqL9iu7xEcg6EtRzWyySvQSDw",
  p: "4c8-yCakazdPx9EMCKR3LGBSzBpGrs0hRd630sDtKXOfvb_1wHurDglKan64BeojgsHRbDpdDHQlJ4ZbASpyTqDWaO_auMVoIn1mhS6ZOYk5nHXhgpchxqlClCDLJU3u77bQLBcuU3akXCaQ9MJPkd7-ebGwNMwGcxOYg0IIfpM",
  q: "uk5ieIGmm0gdBL9t347cePlG7J9SnK06rWrb5BVkc4aucKu6AK6Ekk3KF1e56n3OqubkbXunABKIHi5OTYKAPJuxsMClv3nbNNHxtljz6WAI4OFSfvxb02G_AemPTh-axvlzlZnk0c9yPiQRPJ33GHflZhh62WCIEcHWAiV-MN8",
  dp: "r-27yEzzBOWPLurcKU-Z2eUiHQrLzxzas4kWRwkwvX7sEfYhDdpMJx9t7xLTZShKinFfLKc8H5vN5sFy3bGoZUJCSne1PQfwXg69dT4c-wrC6_ebvxbopdLxoF78ZxAU_Ia-IdvdqAFjhLg3b7qEK-5E7aNW2Yur6rR1uq4T2Ck",
  dq: "IAD7FWxgLGiU443m1_J4mSdpMZik3lk7rTKgF2w9V0MZkC1PxHI2P9OxFZVyUH_QErebIduN8os8asLVnKcAVGkCezR8xImwSECQXxykucBPhiHuw_Wh6Ivv_eobPfZb5jZPzrEjB4-1NkuH0nvoSIHAHGu0HsdgWHyNwMykAs0",
  qi: "k1hIitY9iPzZQqUlqVCXu84mVJn4rNg5dArrx_AUgLa8lP_1qO2LGdYp_oeu6qAthM5bRczaFWGukxtqvYVzsBVqq5Th-lvMANnSFNev4iRSLUG2y1KGiS9c676n00k4Ueav79plS_s_BcU_e1JnwaY2C8_ygW83b-BUHEdc9u8",
  kid: "test-rsa-key",
  alg: "RS256",
  use: "sig",
} satisfies JsonWebKey;

export const rsaPublicJwk = {
  kty: "RSA",
  n: rsaPrivateJwk.n,
  e: rsaPrivateJwk.e,
  kid: rsaPrivateJwk.kid,
  alg: "RS256",
  use: "sig",
  key_ops: ["verify"],
} satisfies JsonWebKey;

const ecKeyPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
export const ecPublicJwk = {
  ...(ecKeyPair.publicKey.export({ format: "jwk" }) as JsonWebKey),
  kid: "test-ec-key",
  alg: "ES256",
  use: "sig",
  key_ops: ["verify"],
} satisfies JsonWebKey;

const ed25519KeyPair = generateKeyPairSync("ed25519");
export const ed25519PublicJwk = {
  ...(ed25519KeyPair.publicKey.export({ format: "jwk" }) as JsonWebKey),
  kid: "test-ed-key",
  alg: "EdDSA",
  use: "sig",
  key_ops: ["verify"],
} satisfies JsonWebKey;

function base64Url(input: Buffer | string): string {
  return (Buffer.isBuffer(input) ? input : Buffer.from(input))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function jwtClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return introspectionClaims({
    exp: 2_000_000_000,
    ...overrides,
  });
}

export function signedJwt(
  claims: Record<string, unknown> = jwtClaims(),
  headerOverrides: Record<string, unknown> = {},
): string {
  const header = {
    alg: "RS256",
    typ: "at+jwt",
    kid: rsaPublicJwk.kid,
    ...headerOverrides,
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const privateKey = createPrivateKey({ key: rsaPrivateJwk, format: "jwk" });
  const signature = createSign("RSA-SHA256").update(signingInput).end().sign(privateKey);
  return `${signingInput}.${base64Url(signature)}`;
}

export function signedEs256Jwt(
  claims: Record<string, unknown> = jwtClaims(),
  headerOverrides: Record<string, unknown> = {},
): string {
  const header = { alg: "ES256", typ: "at+jwt", kid: ecPublicJwk.kid, ...headerOverrides };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signature = createSign("SHA256")
    .update(signingInput)
    .end()
    .sign({ key: ecKeyPair.privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${base64Url(signature)}`;
}

export function signedEdDsaJwt(
  claims: Record<string, unknown> = jwtClaims(),
  headerOverrides: Record<string, unknown> = {},
): string {
  const header = { alg: "EdDSA", typ: "at+jwt", kid: ed25519PublicJwk.kid, ...headerOverrides };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signature = nodeSign(
    null,
    new TextEncoder().encode(signingInput),
    ed25519KeyPair.privateKey,
  );
  return `${signingInput}.${base64Url(signature)}`;
}

export function jwksResponse(
  keys: JsonWebKey[] = [rsaPublicJwk],
  init: ResponseInit = {},
): Response {
  return Response.json({ keys }, init);
}
