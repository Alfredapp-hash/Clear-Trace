# Example Case Workflow

## Scenario

An authorized user believes a public people-search profile displays their old address and phone number.

## Step 1: Intake

Run:

```text
intake-and-consent
```

Outcome:
- authorization status: verified;
- permitted scope: people-search and public web;
- identity claims approved: name, old city/state, old address fragment, phone fragment.

## Step 2: Discovery

Run:

```text
discover-public-exposure
```

Outcome:
- three candidate URLs;
- one duplicate;
- two unique candidate records with redacted evidence.

## Step 3: Identity verification

Run:

```text
verify-identity-match
```

Outcome:
- candidate A: probable match, user confirms;
- candidate B: rejected due to wrong city and unrelated age indicator.

## Step 4: Classification

Run:

```text
classify-exposure
```

Outcome:
- address;
- phone number;
- data-broker profile;
- medium-to-high sensitivity based on user preference.

## Step 5: Controller resolution

Run:

```text
resolve-content-controller
```

Outcome:
- official opt-out form found;
- public privacy email found as fallback;
- no reason to contact host or registrar.

## Step 6: Remedy route

Run:

```text
route-remedy
```

Outcome:
- data-broker opt-out;
- user may need to confirm identity through the broker's own official process.

## Step 7: Draft

Run:

```text
draft-removal-request
```

Outcome:
- factual draft;
- user approves copy or connected-email draft;
- no automatic send.

## Step 8: Verification

Run:

```text
verify-removal
```

Outcome:
- original page no longer contains the information;
- case marked removed_confirmed;
- monthly recheck scheduled.

## Step 9: Reappearance

If the URL later displays the information again:

```text
verify-removal → follow-up-policy
```

Outcome:
- case reopened;
- user receives a reviewable follow-up draft if policy permits.
