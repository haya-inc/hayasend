import type {
  AttachmentObjectReference,
  AttachmentUploadRecord,
  AttachmentUploadTarget,
} from "../core/types.js";

export interface AttachmentStorage {
  createUploadTarget(
    record: AttachmentUploadRecord,
    uploadToken: string,
    apiBaseUrl: string,
  ): Promise<AttachmentUploadTarget>;
  upload(
    record: AttachmentUploadRecord,
    content: Uint8Array,
    contentType: string,
  ): Promise<void>;
  verify(record: AttachmentObjectReference): Promise<void>;
  read(record: AttachmentObjectReference): Promise<Uint8Array>;
}
