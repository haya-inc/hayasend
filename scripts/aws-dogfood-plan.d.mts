export const DOGFOOD_DAYS: 14;
export const DOGFOOD_SLOTS_PER_DAY: 4;
export const DOGFOOD_BATCH_SIZE: 18;
export const DOGFOOD_EXPECTED_TOTAL: 1008;

export const DOGFOOD_NOTIFICATION_TYPES: readonly {
  key: string;
  label: string;
  text: string;
}[];

export interface DogfoodPlan {
  object: "aws_dogfood_plan";
  start_date: string;
  end_date: string;
  run_date: string;
  day_index: number;
  day_number: number | null;
  slot: number;
  active: boolean;
  batch_size: number;
  expected_total: number;
  global_offset: number | null;
}

export function planDogfoodRun(input: {
  startDate: string;
  runDate: string;
  slot: number;
  batchSize?: number;
}): DogfoodPlan;

export function buildDogfoodMessage(
  plan: DogfoodPlan,
  index: number,
  from: string,
  to: string,
): {
  notification_type: string;
  idempotency_key: string;
  payload: {
    from: string;
    to: string;
    subject: string;
    text: string;
  };
};

export function requireDogfoodRetryWindow(
  plan: DogfoodPlan,
  now?: Date,
): {
  scheduled_at: string;
  age_ms: number;
};

export function durationSummary(values: number[]): {
  count: number;
  min_ms: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
};
