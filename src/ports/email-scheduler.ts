export interface EmailScheduler {
  schedule(
    emailId: string,
    scheduledAt?: string,
    now?: Date,
  ): Promise<void>;
  reschedule(
    emailId: string,
    scheduledAt: string,
    now?: Date,
  ): Promise<void>;
  cancel(emailId: string): Promise<void>;
}
