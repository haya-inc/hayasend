/**
 * Provider-specific lifecycle event ingress.
 *
 * Implementations validate and normalize one provider payload before applying
 * it to the provider-neutral recipient ledger. The runtime only supplies the
 * delivery mechanism (SNS, Event Grid, Queue, Pub/Sub, or HTTP).
 */
export interface TransportEventIngress<
  TEvent,
  TContext = undefined,
  TResult = void,
> {
  receive(event: TEvent, context?: TContext): Promise<TResult>;
}
