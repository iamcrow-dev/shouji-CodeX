import crypto from "node:crypto";

export function generateToken(length = 32) {
  let token = "";

  while (token.length < length) {
    token += crypto.randomBytes(length).toString("base64url");
  }

  return token.slice(0, length);
}
