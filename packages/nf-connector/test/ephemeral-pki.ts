// Test only: short-lived P-256 CA and signed server leaf. No private keys on disk,
// certificates embedded in the plugin, external openssl binary, or system trust changes.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
const hex = (s: string) => Buffer.from(s, "hex");
function der(tag: number, ...parts: Buffer[]): Buffer {
  const value = Buffer.concat(parts), n = value.length;
  const len = n < 128 ? [n] : n < 256 ? [0x81,n] : [0x82,n >>> 8,n & 255];
  return Buffer.concat([Buffer.from([tag,...len]),value]);
}
const seq = (...parts: Buffer[]) => der(0x30,...parts);
const oid = (s: string) => der(0x06,hex(s));
const dn = (name: string) => seq(der(0x31,seq(oid("550403"),der(0x0c,Buffer.from(name)))));
const alg = seq(oid("2a8648ce3d040302")); // ecdsa-with-SHA256
function stamp(offset: number): Buffer { return der(0x18,Buffer.from(new Date(Date.now()+offset).toISOString().replace(/[-:T]/g,"").slice(0,14)+"Z")); }
function certificate(subject: Buffer, issuer: Buffer, pub: KeyObject, signer: KeyObject, ip?: number[]): Buffer {
  const truth = der(1,hex("ff")), ext = (id: string, critical: boolean, bytes: Buffer) => seq(oid(id),...(critical ? [truth] : []),der(4,bytes));
  const extensions = [ext("551d13",true,ip ? seq() : seq(truth)),ext("551d0f",true,der(3,ip ? hex("0780") : hex("0106")))];
  if (ip) extensions.push(ext("551d11",false,seq(der(0x87,Buffer.from(ip)))),ext("551d25",false,seq(oid("2b06010505070301"))));
  const tbs = seq(der(0xa0,der(2,hex("02"))),der(2,Buffer.concat([hex("01"),randomBytes(8)])),alg,issuer,seq(stamp(-86400000),stamp(86400000)),subject,pub.export({type:"spki",format:"der"}),der(0xa3,seq(...extensions)));
  return seq(tbs,alg,der(3,hex("00"),sign("sha256",tbs,signer)));
}
const pem = (buf: Buffer) => `-----BEGIN CERTIFICATE-----\n${buf.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
export function ephemeralPki() {
  const gen = () => generateKeyPairSync("ec",{namedCurve:"prime256v1"});
  const ca = gen(), issuer = dn("NF ephemeral test CA"), root = certificate(issuer,issuer,ca.publicKey,ca.privateKey);
  const trust = {centerCaPem:pem(root),centerCaSha256:createHash("sha256").update(root).digest("hex")};
  return {trust, leaf(ip: number[] = [127,0,0,1]) { const key = gen(); return {cert:pem(certificate(dn("NF test server"),issuer,key.publicKey,ca.privateKey,ip)),key:key.privateKey.export({type:"pkcs8",format:"pem"}) as string}; }};
}
