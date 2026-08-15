export type JobNotification = {
  jobId: string;
  status: string;
  message: string;
};

export interface NotificationSink {
  publish(notification: JobNotification): Promise<void>;
}

export class NoopNotificationSink implements NotificationSink {
  async publish(_notification: JobNotification): Promise<void> {}
}

export class ConsoleNotificationSink implements NotificationSink {
  async publish(notification: JobNotification): Promise<void> {
    process.stderr.write(
      `[${notification.jobId}] ${notification.status}: ${notification.message}\n`,
    );
  }
}
