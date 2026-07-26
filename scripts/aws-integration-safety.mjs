export function normalizeApiGatewayBaseUrl(value, expectedApiId, region) {
  if (
    !/^[a-z0-9]+$/.test(expectedApiId) ||
    !/^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/.test(region)
  ) {
    throw new Error("The expected API Gateway identifier or Region is invalid.");
  }
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("HAYASEND_BASE_URL must be an absolute URL.");
  }
  const expectedHostname =
    `${expectedApiId}.execute-api.${region}.amazonaws.com`;
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname !== expectedHostname ||
    endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(
      "HAYASEND_BASE_URL must be the expected dedicated API Gateway endpoint.",
    );
  }
  return `https://${expectedHostname}`;
}
