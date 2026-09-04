const required = [
  "OOMOL_CONNECT_ADMIN_TOKEN",
  "OOMOL_CONNECT_JWKS_URI",
  "OOMOL_CONNECT_JWT_ISSUER",
  "OOMOL_CONNECT_JWT_AUDIENCE",
  "IDENTITY_USER_POOL_REF",
];

for (const name of required) {
  if (!process.env[name]?.trim()) {
    throw new Error(`Missing required identity configuration: ${name}`);
  }
}

const response = await fetch("http://127.0.0.1:3000/api/identity-provider", {
  method: "PUT",
  headers: {
    authorization: `Bearer ${process.env.OOMOL_CONNECT_ADMIN_TOKEN}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    issuer: process.env.OOMOL_CONNECT_JWT_ISSUER,
    audience: process.env.OOMOL_CONNECT_JWT_AUDIENCE,
    jwksUri: process.env.OOMOL_CONNECT_JWKS_URI,
    userPoolRef: process.env.IDENTITY_USER_POOL_REF,
    subjectClaim: "sub",
    groupsClaim: "groups",
  }),
});

if (!response.ok) {
  throw new Error(`Identity configuration failed with HTTP ${response.status}.`);
}

console.log("Identity provider configuration applied.");
