export interface B2S3FileVersionBinding {
  fileName: string;
  fileId: string;
  bucketId: string;
  contentLength: number;
  contentType: string;
  uploadTimestamp: number;
  fileInfo: Record<string, string>;
  action: string;
  serverSideEncryption?: string;
}

export interface B2S3VersionGuard {
  resolveS3FileVersion(input: {
    bucket: string;
    key: string;
    versionId: string;
  }): Promise<B2S3FileVersionBinding>;
  getCurrentS3FileVersion(input: {
    bucket: string;
    key: string;
  }): Promise<B2S3FileVersionBinding | null>;
}
