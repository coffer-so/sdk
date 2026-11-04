import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

test("ABI CLI last --idl-dir wins and an actual wire mismatch remains a failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "coffer-sdk-abi-"));
  mkdirSync(join(directory, "idl"));
  for (const name of ["coffer_pool", "protocol_admin", "single_token_liquidity"]) writeFileSync(join(directory,"idl",`${name}.json`), readFileSync(resolve(__dirname,`../src/idl/${name}.json`)));
  const script = resolve(__dirname,"../scripts/check-contract-abi.cjs");
  const args = [script,"--contracts-dir",directory,"--idl-dir","missing-directory","--idl-dir","idl","--ignore-address"];
  const success = spawnSync(process.execPath,args,{ encoding:"utf8" });
  expect(success.status).toBe(0);
  const receipt = JSON.parse(success.stdout);
  expect(receipt.programs.map((p: any) => [p.instructions,p.events])).toEqual([[51,41],[55,38],[4,2]]);
  expect(receipt.programs.every((p: any) => p.matches && /^[a-f0-9]{64}$/.test(p.sdkIdlSha256))).toBe(true);
  const file = join(directory,"idl/coffer_pool.json");
  const idl = JSON.parse(readFileSync(file,"utf8")); idl.instructions[0].discriminator[0] ^= 1; writeFileSync(file,JSON.stringify(idl));
  const bad = spawnSync(process.execPath,args,{ encoding:"utf8" });
  expect(bad.status).toBe(1); expect(JSON.parse(bad.stdout).programs[0].matches).toBe(false);
});
