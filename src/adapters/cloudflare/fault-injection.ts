export type CloudflareFaultComponent = "d1" | "r2" | "queue";

export interface CloudflareFaultPoint {
  component: CloudflareFaultComponent;
  operation: string;
  target: string;
  index?: number | undefined;
}

export type CloudflareFaultInjector = (
  point: CloudflareFaultPoint,
) => void | Promise<void>;

export async function injectCloudflareFault(
  injector: CloudflareFaultInjector | undefined,
  point: CloudflareFaultPoint,
): Promise<void> {
  await injector?.(point);
}
