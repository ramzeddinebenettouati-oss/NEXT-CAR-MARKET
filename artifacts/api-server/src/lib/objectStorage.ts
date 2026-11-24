import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "stream";
import { randomUUID } from "crypto";
import {
  ObjectAclPolicy,
  ObjectPermission,
  canAccessObject,
  getObjectAclPolicy,
  setObjectAclPolicy,
} from "./objectAcl";

/**
 * S3-compatible object storage (Supabase Storage, Cloudflare R2, AWS S3, MinIO…).
 *
 * Required env:
 *   S3_ENDPOINT           e.g. https://<project-ref>.supabase.co/storage/v1/s3
 *   S3_REGION             e.g. eu-central-1 (Supabase: your project's region)
 *   S3_ACCESS_KEY_ID
 *   S3_SECRET_ACCESS_KEY
 *   PRIVATE_OBJECT_DIR    "/<bucket>/<prefix>", e.g. /autocango/.private
 *   PUBLIC_OBJECT_SEARCH_PATHS  comma-separated "/<bucket>/<prefix>" list
 * Optional:
 *   S3_FORCE_PATH_STYLE   defaults to "true" (required by Supabase and MinIO)
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. See .env.example for object storage configuration.`);
  }
  return value;
}

let s3Client: S3Client | null = null;

export function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: requireEnv("S3_ENDPOINT"),
      region: process.env.S3_REGION || "us-east-1",
      forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "true") !== "false",
      credentials: {
        accessKeyId: requireEnv("S3_ACCESS_KEY_ID"),
        secretAccessKey: requireEnv("S3_SECRET_ACCESS_KEY"),
      },
    });
  }
  return s3Client;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === "NotFound" ||
    e?.name === "NoSuchKey" ||
    e?.$metadata?.httpStatusCode === 404
  );
}

export interface StoredObjectMetadata {
  contentType?: string;
  size?: number;
  /** User-defined metadata (S3 x-amz-meta-*). Keys are lower-case. */
  metadata?: Record<string, string>;
}

/**
 * Handle to one object in a bucket. Its method names follow the
 * @google-cloud/storage `File` class used before the move off Replit, so the
 * routes and ACL code did not need to change.
 */
export class StoredObject {
  constructor(
    public readonly bucket: string,
    public readonly name: string,
  ) {}

  private async head(): Promise<HeadObjectCommandOutput> {
    return getS3Client().send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.name }));
  }

  async exists(): Promise<[boolean]> {
    try {
      await this.head();
      return [true];
    } catch (err) {
      if (isNotFound(err)) return [false];
      throw err;
    }
  }

  async getMetadata(): Promise<[StoredObjectMetadata]> {
    const head = await this.head();
    return [
      {
        contentType: head.ContentType,
        size: head.ContentLength,
        metadata: head.Metadata ?? {},
      },
    ];
  }

  /** Merges `metadata` into the object's user metadata (S3 needs a self-copy for this). */
  async setMetadata({ metadata }: { metadata: Record<string, string> }): Promise<void> {
    const head = await this.head();
    await getS3Client().send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: this.name,
        CopySource: `${this.bucket}/${encodeURIComponent(this.name).replace(/%2F/g, "/")}`,
        MetadataDirective: "REPLACE",
        ContentType: head.ContentType,
        CacheControl: head.CacheControl,
        Metadata: { ...(head.Metadata ?? {}), ...metadata },
      }),
    );
  }

  async createReadStream(): Promise<Readable> {
    const out = await getS3Client().send(new GetObjectCommand({ Bucket: this.bucket, Key: this.name }));
    return out.Body as Readable;
  }

  async delete(opts?: { ignoreNotFound?: boolean }): Promise<void> {
    try {
      await getS3Client().send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.name }));
    } catch (err) {
      if (opts?.ignoreNotFound && isNotFound(err)) return;
      throw err;
    }
  }
}

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class ObjectStorageService {
  constructor() {}

  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((path) => path.trim())
          .filter((path) => path.length > 0)
      )
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Set it to a comma-separated list of " +
          "/<bucket>/<prefix> paths (see .env.example)."
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Set it to /<bucket>/<prefix> (see .env.example)."
      );
    }
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<StoredObject | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;

      const { bucketName, objectName } = parseObjectPath(fullPath);
      const file = new StoredObject(bucketName, objectName);

      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }

    return null;
  }

  async downloadObject(file: StoredObject, cacheTtlSec: number = 3600): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const aclPolicy = await getObjectAclPolicy(file);
    const isPublic = aclPolicy?.visibility === "public";

    const nodeStream = await file.createReadStream();
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    const headers: Record<string, string> = {
      "Content-Type": metadata.contentType || "application/octet-stream",
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
    };
    if (metadata.size) {
      headers["Content-Length"] = String(metadata.size);
    }

    return new Response(webStream, { headers });
  }

  async getObjectEntityUploadURL(options?: {
    namespace?: string;
    ownerId?: string;
  }): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();

    const objectId = randomUUID();
    const namespace = options?.namespace?.replace(/^\/+|\/+$/g, "") || "uploads";
    const ownerPath = options?.ownerId ? `/${options.ownerId}` : "";
    const fullPath = `${privateObjectDir}/${namespace}${ownerPath}/${objectId}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    return getSignedUrl(
      getS3Client(),
      new PutObjectCommand({ Bucket: bucketName, Key: objectName }),
      { expiresIn: 900 },
    );
  }

  async getObjectEntityFile(objectPath: string): Promise<StoredObject> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const objectFile = new StoredObject(bucketName, objectName);
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return objectFile;
  }

  /**
   * Turns a presigned upload URL into the app's stable "/objects/<id>" path.
   * Anything that is not a URL on our S3 endpoint is returned unchanged.
   */
  normalizeObjectEntityPath(rawPath: string): string {
    const endpoint = process.env.S3_ENDPOINT;
    if (!endpoint || !/^https?:\/\//.test(rawPath)) {
      return rawPath;
    }

    const url = new URL(rawPath);
    const endpointUrl = new URL(endpoint);
    if (url.host !== endpointUrl.host) {
      return rawPath;
    }

    // Path-style URL: <endpoint path>/<bucket>/<key>
    const endpointPath = endpointUrl.pathname.replace(/\/+$/, "");
    let rawObjectPath = decodeURIComponent(url.pathname);
    if (endpointPath && rawObjectPath.startsWith(endpointPath)) {
      rawObjectPath = rawObjectPath.slice(endpointPath.length);
    }

    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith("/")) {
      objectEntityDir = `${objectEntityDir}/`;
    }

    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }

    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) {
      return normalizedPath;
    }

    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  async deleteObjectEntity(objectPath: string): Promise<void> {
    const objectFile = await this.getObjectEntityFile(objectPath);
    await objectFile.delete({ ignoreNotFound: true });
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: StoredObject;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  const pathParts = path.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join("/");

  return {
    bucketName,
    objectName,
  };
}
