import crypto from "node:crypto";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const rl = readline.createInterface({ input, output });

try {
  const password = await rl.question("Password to hash: ");
  if (!password) {
    throw new Error("Password is required");
  }

  const salt = crypto.randomBytes(16).toString("base64url");
  const key = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derived) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derived);
    });
  });

  console.log(`APP_PASSWORD_HASH=scrypt:${salt}:${key.toString("base64url")}`);
} finally {
  rl.close();
}
