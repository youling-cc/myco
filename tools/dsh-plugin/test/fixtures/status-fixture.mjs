/**
 * Mock `myco` executable used by the plugin tests.
 *
 * Behaves like the real CLI for the scenarios this spike must pin:
 * a healthy status object, the three broken shapes, unparsable output, a
 * non-zero exit, and a process that outlives the probe timeout.
 *
 * Usage: node status-fixture.mjs <scenario>
 */

const scenario = process.argv[2] ?? "loggedIn";

const loggedIn = {
  accounts: 5,
  configDir: "C:\\Users\\example\\AppData\\Roaming\\youling",
  delegations: 6,
  deviceDid: "did:myco:z6MkExampleDeviceDIDxxxxxxxxxxxxxxxxxxxxxxxxxx",
  role: "embodiment",
  rootDid: "did:youling:z6MkExampleAccountDIDxxxxxxxxxxxxxxxxxxxxxxxxx",
  version: "0.3.193",
};

const scenarios = {
  loggedIn,
  // Logged out: a perfectly valid device DID is present, but there is no person.
  unlinked: { ...loggedIn, rootDid: null, role: "unlinked", accounts: 0 },
  // Half-broken: the person DID survived but the account state did not.
  halfLoggedIn: { ...loggedIn, role: "unlinked" },
  // Half-broken: no device DID at all (key absent, as a real payload would be).
  noDevice: (() => {
    const { deviceDid: _dropped, ...rest } = loggedIn;
    return rest;
  })(),
  // Half-broken: explicit null device DID.
  nullDevice: { ...loggedIn, deviceDid: null },
  // Valid shape, but the title lookup is the only thing under test here.
  noTitle: { ...loggedIn },
};

switch (scenario) {
  case "hang":
    // Outlives any probe timeout; the harness must kill this process.
    setTimeout(() => {}, 60_000);
    break;
  case "garbage":
    process.stdout.write("myco: unexpected internal error\n");
    break;
  case "noisy":
    // Banner before the JSON object must still parse.
    process.stdout.write(`youling cli 0.3.193\n${JSON.stringify(loggedIn)}\n`);
    break;
  case "exitNonZero":
    process.stdout.write(JSON.stringify(loggedIn));
    process.exitCode = 3;
    break;
  default: {
    const payload = scenarios[scenario] ?? loggedIn;
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
}
