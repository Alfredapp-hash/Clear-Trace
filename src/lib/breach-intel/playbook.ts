export interface BreachResponseAction {
  id: string;
  priority: "immediate" | "soon" | "monitor";
  title: string;
  detail: string;
}

export function breachResponsePlaybook(dataClasses: string[]): BreachResponseAction[] {
  const lower = dataClasses.map((c) => c.toLowerCase());
  const actions: BreachResponseAction[] = [
    {
      id: "rotate_passwords",
      priority: "immediate",
      title: "Rotate passwords",
      detail: "Change passwords on any account that reused this email. Use a unique password per site.",
    },
    {
      id: "enable_mfa",
      priority: "immediate",
      title: "Enable MFA",
      detail: "Turn on multi-factor authentication on email, banking, and identity-critical accounts.",
    },
  ];

  if (lower.some((c) => c.includes("password"))) {
    actions.push({
      id: "password_manager",
      priority: "immediate",
      title: "Audit password reuse",
      detail: "Assume exposed passwords are compromised. Update every account that shared the same password.",
    });
  }

  if (lower.some((c) => c.includes("social security") || c.includes("ssn"))) {
    actions.push({
      id: "credit_freeze",
      priority: "immediate",
      title: "Credit freeze & fraud alert",
      detail: "Place freezes with major credit bureaus and consider an IRS Identity Protection PIN.",
    });
  }

  if (lower.some((c) => c.includes("phone"))) {
    actions.push({
      id: "sim_swap",
      priority: "soon",
      title: "SIM-swap hardening",
      detail: "Contact your carrier to add a port-out PIN and review SMS-based 2FA accounts.",
    });
  }

  actions.push({
    id: "monitor_accounts",
    priority: "monitor",
    title: "Monitor for reuse",
    detail: "Watch financial and email accounts for 90 days. Schedule a ClearTrace verification recheck.",
  });

  return actions;
}