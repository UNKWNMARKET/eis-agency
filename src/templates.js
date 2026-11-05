// Starter communication templates. Merge fields: {{client_name}} {{first_name}} {{policy_number}} {{carrier}}
// {{line}} {{effective_date}} {{expiration_date}} {{premium}} {{agent_name}} {{agency_name}} {{agency_phone}} {{agency_email}}

export const DEFAULT_TEMPLATES = [
  {
    name: 'Renewal notice (60 days)',
    category: 'renewal',
    subject: 'Your {{line}} policy renews on {{expiration_date}}',
    body: `Hi {{first_name}},

Your {{line}} policy with {{carrier}} (policy {{policy_number}}) is scheduled to renew on {{expiration_date}}.

We are reviewing your coverage and the renewal terms now to make sure you still have the right protection at the best price. If anything has changed — a new vehicle, home improvements, a new business location, or other life changes — please let us know so we can update your policy.

I'll be in touch as soon as renewal terms are available. Feel free to call or reply with any questions.

Thank you,
{{agent_name}}
{{agency_name}}
{{agency_phone}}`,
  },
  {
    name: 'Renewal offer / premium change',
    category: 'renewal',
    subject: 'Renewal terms for policy {{policy_number}}',
    body: `Hi {{first_name}},

Your renewal terms for {{line}} policy {{policy_number}} with {{carrier}} are ready. The renewal premium is {{premium}} for the term beginning {{effective_date}}.

Please let me know if you would like to review options, adjust coverage or deductibles, or have us market your policy to other carriers.

Thank you,
{{agent_name}}
{{agency_name}} · {{agency_phone}}`,
  },
  {
    name: 'Payment reminder',
    category: 'billing',
    subject: 'Payment reminder — policy {{policy_number}}',
    body: `Hi {{first_name}},

This is a friendly reminder that a payment for your {{line}} policy ({{policy_number}}) is due. To avoid any lapse in coverage, please submit payment as soon as possible, or call us if you'd like to discuss payment options.

Thank you,
{{agent_name}}
{{agency_name}} · {{agency_phone}}`,
  },
  {
    name: 'Welcome new client',
    category: 'sales',
    subject: 'Welcome to {{agency_name}}',
    body: `Hi {{first_name}},

Thank you for choosing {{agency_name}} for your insurance needs. Your {{line}} policy {{policy_number}} with {{carrier}} is effective {{effective_date}}.

Your coverage documents will follow shortly. If you have any questions, or need to make a change or report a claim, call us at {{agency_phone}} or reply to this email — we're here to help.

Welcome aboard,
{{agent_name}}
{{agency_name}}`,
  },
  {
    name: 'Claim follow-up',
    category: 'claims',
    subject: 'Following up on your claim',
    body: `Hi {{first_name}},

I'm checking in on the claim you reported under policy {{policy_number}}. Please let me know if you have heard from the adjuster, and if there is any additional documentation I can help you gather.

If you need anything in the meantime, I'm happy to help.

{{agent_name}}
{{agency_name}} · {{agency_phone}}`,
  },
  {
    name: 'Certificate of insurance sent',
    category: 'service',
    subject: 'Certificate of insurance for {{client_name}}',
    body: `Hello,

Please find the attached certificate of insurance for {{client_name}}. Let me know if you need any changes to the certificate holder or description.

{{agent_name}}
{{agency_name}} · {{agency_phone}}`,
  },
];
