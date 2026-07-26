import type {
  DownloadTarget,
  ReceivedEmailContent,
} from "../core/types.js";

export interface InboundStorage {
  readRaw(objectKey: string): Promise<Uint8Array>;
  writeContent(
    objectKey: string,
    content: ReceivedEmailContent,
  ): Promise<void>;
  readContent(objectKey: string): Promise<ReceivedEmailContent>;
  writeAttachment(
    objectKey: string,
    content: Uint8Array,
    contentType: string,
  ): Promise<void>;
  readAttachment(objectKey: string): Promise<Uint8Array>;
  createDownloadTarget(
    objectKey: string,
    filename: string,
    contentType: string,
  ): Promise<DownloadTarget>;
}
