// One-off: copy every object from Replit App Storage to an S3-compatible
// bucket (Supabase Storage), translating the ACL metadata the app uses.
//
// Run this INSIDE the old Replit workspace (Shell tab), because Replit's
// storage credentials only work there. See docs/MIGRATION-FROM-REPLIT.md.
//
//   mkdir -p /tmp/mig && cp scripts/migrate-from-replit/copy-object-storage.mjs /tmp/mig/
//   cd /tmp/mig && npm init -y >/dev/null && npm i @google-cloud/storage @aws-sdk/client-s3
//   SOURCE_BUCKET=replit-objstore-... TARGET_BUCKET=autocango \
//   S3_ENDPOINT=... S3_REGION=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
//   node copy-object-storage.mjs            # add DRY_RUN=1 to only list
import { Storage } from "@google-cloud/storage";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const SIDECAR = "http://127.0.0.1:1106";
const need = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`Missing env ${k}`);
    process.exit(1);
  }
  return v;
};

const sourceBucket = need("SOURCE_BUCKET");
const targetBucket = need("TARGET_BUCKET");
const dryRun = process.env.DRY_RUN === "1";

const gcs = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${SIDECAR}/token`,
    type: "external_account",
    credential_source: {
      url: `${SIDECAR}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

const s3 = new S3Client({
  endpoint: need("S3_ENDPOINT"),
  region: need("S3_REGION"),
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "true") !== "false",
  credentials: {
    accessKeyId: need("S3_ACCESS_KEY_ID"),
    secretAccessKey: need("S3_SECRET_ACCESS_KEY"),
  },
});

async function existsInTarget(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: targetBucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

const [files] = await gcs.bucket(sourceBucket).getFiles();
console.log(`${files.length} objects in ${sourceBucket}${dryRun ? " (dry run)" : ""}`);

let copied = 0;
let skipped = 0;
let failed = 0;
for (const file of files) {
  if (file.name.endsWith("/")) continue;
  try {
    if (await existsInTarget(file.name)) {
      skipped++;
      continue;
    }
    const [meta] = await file.getMetadata();
    const metadata = {};
    // GCS key "custom:aclPolicy" → S3 key "aclpolicy" (see lib/objectAcl.ts)
    const acl = meta.metadata?.["custom:aclPolicy"];
    if (acl) metadata.aclpolicy = String(acl);

    console.log(`${dryRun ? "would copy" : "copy"} ${file.name} (${meta.size} bytes${acl ? ", acl" : ""})`);
    if (dryRun) continue;

    const [body] = await file.download();
    await s3.send(
      new PutObjectCommand({
        Bucket: targetBucket,
        Key: file.name,
        Body: body,
        ContentType: meta.contentType || "application/octet-stream",
        Metadata: metadata,
      }),
    );
    copied++;
  } catch (err) {
    failed++;
    console.error(`FAILED ${file.name}: ${err?.message ?? err}`);
  }
}

console.log(`\nDone: ${copied} copied, ${skipped} already present, ${failed} failed.`);
console.log("\nOn Render, set:");
const swap = (p) => p.replace(`/${sourceBucket}/`, `/${targetBucket}/`);
if (process.env.PRIVATE_OBJECT_DIR) console.log(`  PRIVATE_OBJECT_DIR=${swap(process.env.PRIVATE_OBJECT_DIR)}`);
if (process.env.PUBLIC_OBJECT_SEARCH_PATHS) {
  console.log(`  PUBLIC_OBJECT_SEARCH_PATHS=${process.env.PUBLIC_OBJECT_SEARCH_PATHS.split(",").map((p) => swap(p.trim())).join(",")}`);
}
process.exit(failed ? 1 : 0);
