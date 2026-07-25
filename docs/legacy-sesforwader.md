# Relationship to sesforwader

HayaSend started from a review of `yhay81/sesforwader`, a small Python Lambda
package published in 2018.

HayaSend is a clean-room TypeScript implementation with a different
architecture and contains no copied source from that repository or from
`arithmetric/aws-lambda-ses-forwarder`. The historical projects remain useful
references for the original forwarding problem and retain their respective
MIT notices.

Inbound forwarding will be implemented as a new HayaSend module after the
transactional API reaches a reliable baseline.
