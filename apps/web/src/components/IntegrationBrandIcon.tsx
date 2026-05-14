import type { IntegrationKind } from "@agent-workbench/shared";

export function IntegrationBrandIcon({
  kind,
  size = 18,
  className
}: {
  kind: IntegrationKind;
  size?: number;
  className?: string;
}) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", className, "aria-hidden": true } as const;
  switch (kind) {
    case "discord":
      return (
        <svg {...common} fill="none">
          <path d="M7.4 7.2c2.1-1 7.1-1 9.2 0l1.3 8.6c-1.7 1.2-3.4 2-5.9 2.4-2.4-.4-4.2-1.1-5.9-2.4l1.3-8.6Z" fill="#5865F2" />
          <circle cx="9.9" cy="11.9" r="1.1" fill="#fff" />
          <circle cx="14.1" cy="11.9" r="1.1" fill="#fff" />
          <path d="M9.1 14c1 .7 4.8.7 5.8 0" stroke="#fff" strokeLinecap="round" strokeWidth="1.2" />
        </svg>
      );
    case "feishu":
      return (
        <svg {...common} fill="none">
          <path d="M11.7 3.2c1.6 1.1 3 3 3.4 4.8-2.1-.2-4.6-1.2-6.1-2.6 0-1.2 1.1-2.1 2.7-2.2Z" fill="#00C2FF" />
          <path d="M18.7 8.7c.3 1.9-.2 4.2-1.3 5.7-1.8-1.2-3.5-3.4-4.1-5.4.7-1 2.4-1.2 5.4-.3Z" fill="#3370FF" />
          <path d="M14.4 20.1c-1.9.5-4.2.2-5.9-.9 1-1.8 3.1-3.7 5-4.4 1.1.6 1.4 2.3.9 5.3Z" fill="#00D6B9" />
          <path d="M4.7 15.4c-.7-1.8-.6-4.1.1-5.8 1.9.7 4.1 2.4 5.2 4.2-.4 1.1-1.9 1.9-5.3 1.6Z" fill="#FF6B3D" />
        </svg>
      );
    case "slack":
      return (
        <svg {...common} fill="none">
          <rect x="4.4" y="9.6" width="6.1" height="2.9" rx="1.45" fill="#36C5F0" />
          <rect x="8.7" y="4.3" width="2.9" height="6.1" rx="1.45" fill="#2EB67D" />
          <rect x="13.5" y="11.5" width="6.1" height="2.9" rx="1.45" fill="#ECB22E" />
          <rect x="12.3" y="13.5" width="2.9" height="6.1" rx="1.45" fill="#E01E5A" />
        </svg>
      );
    case "telegram":
      return (
        <svg {...common} fill="none">
          <circle cx="12" cy="12" r="9" fill="#2AABEE" />
          <path d="m7.3 11.8 8.2-3.2c.8-.3 1.5.2 1.3 1.2l-1.4 6.7c-.1.7-.8.8-1.3.5l-2.2-1.6-1.1 1.1c-.1.1-.2.2-.4.2l.2-2.6 4.8-4.4-5.9 3.9-2.3-.7c-.7-.2-.7-1.1.1-1.1Z" fill="#fff" />
        </svg>
      );
    case "wecom":
      return (
        <svg {...common} fill="none">
          <path d="M7.5 6.3c2.3-1.8 5.9-2 8.4-.5 2.1 1.2 3.3 3.4 3.1 5.8-.2 2.2-1.6 4.3-3.8 5.4l.7 2.1-2.5-1.2a9.6 9.6 0 0 1-3.1.1c-4.1-.5-6.9-3.6-6.6-7.2.1-1.8 1-3.4 2.4-4.5Z" fill="#07C160" />
          <path d="M6.3 8.7c-1.4 1.1-2.1 2.5-2 4.1.1 2 1.5 3.8 3.7 4.7l-.5 1.7 2-.9h.9c-2-.8-3.4-2.4-3.6-4.4-.1-1.7.5-3.6 1.8-5.2-.8-.1-1.6.1-2.3.5Z" fill="#5AD7FF" />
          <circle cx="9.7" cy="11.5" r="1" fill="#fff" />
          <circle cx="13" cy="11" r=".95" fill="#fff" />
          <circle cx="15.8" cy="12.6" r=".95" fill="#fff" />
        </svg>
      );
  }
}
