// The default-features build of horizon_zero that a real validator may load, and the guard against
// loading anything else.
//
// `inline-mock-vrf` and `inline-mock-magic` builds (the LiteSVM suite's) write the same
// target/deploy/horizon_zero.so. Such a build skips the rollup's ephemeral accounts, delegation and
// commits, and fakes the VRF, so it must never reach the local stack or a cluster. `buildDefault`
// builds with default features for one rollup validator, which the program delegates to and gets
// as HZ_VALIDATOR, and one VRF oracle queue, the only one lock_army asks, as HZ_VRF_QUEUE (see
// programs/horizon-zero/build.rs). It records the build in target/deploy/horizon_zero.so.build.json:
// the features, the validator, the queue and the SHA-256 of the .so. `assertDefaultBuild` refuses a
// .so whose hash is not the recorded one, which is what any later mock build leaves behind, and one
// built for another validator or queue.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SO = "target/deploy/horizon_zero.so";
export const RECORD = `${SO}.build.json`;

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Builds programs/horizon-zero with default features for `validator` and `oracleQueue` (base58) and
 * records the build.
 */
export function buildDefault(root, { validator, oracleQueue }, log = (line) => process.stdout.write(`${line}\n`)) {
  if (!validator) throw new Error("buildDefault needs the rollup validator identity the program delegates to");
  if (!oracleQueue) throw new Error("buildDefault needs the VRF oracle queue lock_army asks");
  const args = ["--manifest-path", "programs/horizon-zero/Cargo.toml"];
  log(`HZ_VALIDATOR=${validator} HZ_VRF_QUEUE=${oracleQueue} cargo-build-sbf ${args.join(" ")}`);
  const env = { ...process.env, HZ_VALIDATOR: validator, HZ_VRF_QUEUE: oracleQueue };
  const result = spawnSync("cargo-build-sbf", args, { cwd: root, stdio: "inherit", env });
  if (result.status !== 0) throw new Error("cargo-build-sbf for programs/horizon-zero failed");
  const so = path.join(root, SO);
  fs.writeFileSync(path.join(root, RECORD), `${JSON.stringify({ features: "default", validator, oracleQueue, sha256: sha256(so) }, null, 2)}\n`);
}

/**
 * Throws unless target/deploy/horizon_zero.so is the one `buildDefault` built last: the record is
 * there, says default features, `validator` and `oracleQueue`, and its hash matches the file.
 */
export function assertDefaultBuild(root, { validator, oracleQueue }) {
  const so = path.join(root, SO);
  if (!fs.existsSync(so)) throw new Error(`${SO} is missing: build it with default features`);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(path.join(root, RECORD), "utf8"));
  } catch {
    throw new Error(`${SO} has no build record (${RECORD}): it may be a mock build. Build it here with default features instead of reusing it`);
  }
  if (record.features !== "default" || record.sha256 !== sha256(so)) {
    throw new Error(`${SO} is not the default-features build recorded in ${RECORD} (a mock build since?). Build it here instead of reusing it`);
  }
  if (record.validator !== validator) {
    throw new Error(`${SO} was built for validator ${record.validator ?? "unknown"}, not ${validator}. Build it here instead of reusing it`);
  }
  if (record.oracleQueue !== oracleQueue) {
    throw new Error(`${SO} was built for VRF queue ${record.oracleQueue ?? "unknown"}, not ${oracleQueue}. Build it here instead of reusing it`);
  }
}
