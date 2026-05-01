interface IconProps {
  className?: string;
}

export function TasksIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M6.25 5.625h8.125M6.25 10h8.125M6.25 14.375h5.625M3.75 5.625h.625M3.75 10h.625M3.75 14.375h.625" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function DashboardIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M4.375 4.375h4.375v4.375H4.375zm6.875 0h4.375v7.5H11.25zm-6.875 6.875h4.375v4.375H4.375zm6.875 1.25h4.375v3.125H11.25z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function QueueIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M5 5h10M5 10h10M5 15h6.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SettingsIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M10 4.375v2.5M10 13.125v2.5M4.375 10h2.5M13.125 10h2.5M6.022 6.022l1.768 1.768M12.21 12.21l1.768 1.768M13.978 6.022 12.21 7.79M7.79 12.21l-1.768 1.768M12.5 10a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SlidersIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M5 5h10M5 15h10M7.5 10h7.5M7.5 5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm7.5 10a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0ZM10 10a1.25 1.25 0 1 1-2.5 0A1.25 1.25 0 0 1 10 10Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ConnectionIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <circle cx="5.625" cy="10" r="1.875" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="14.375" cy="6.25" r="1.875" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="14.375" cy="13.75" r="1.875" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.5 9.25 12.5 7.125M7.5 10.75l5 2.125" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CapabilityIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M10 3.75 12.11 8.03l4.726.687-3.418 3.33.807 4.707L10 14.54l-4.225 2.214.807-4.707-3.418-3.33 4.726-.687L10 3.75Z" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SkillsIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M5.625 4.375h8.75a1.25 1.25 0 0 1 1.25 1.25v8.75a1.25 1.25 0 0 1-1.25 1.25h-8.75a1.25 1.25 0 0 1-1.25-1.25v-8.75a1.25 1.25 0 0 1 1.25-1.25Zm2.5 0v11.25m1.875-7.5h3.125m-3.125 3.125h3.125" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function StateIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M4.375 13.125h2.188L8.75 7.5l2.188 5 1.874-3.125h2.813" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.375 16.25h11.25" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeOpacity="0.45" />
    </svg>
  );
}

export function ImprovementsIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M10 3.75v2.188M10 14.063v2.187M4.844 6.094l1.562 1.562M13.594 14.844l1.562 1.562M3.75 10h2.188M14.063 10h2.187M4.844 13.906l1.562-1.562M13.594 5.156l1.562-1.562M12.5 10a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ChevronLeftIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="m11.875 5-5 5 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ChevronRightIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="m8.125 5 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SelectArrowsIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="m7 8 3-3 3 3M13 12l-3 3-3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ArchiveIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M4.375 5.625h11.25v8.75a1.25 1.25 0 0 1-1.25 1.25h-8.75a1.25 1.25 0 0 1-1.25-1.25v-8.75Zm0 0 1.25-1.875h8.75l1.25 1.875M8.125 9.375h3.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PlusIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M10 4.375v11.25M4.375 10h11.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function RefreshIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M15 7.5V4.375H11.875M5 12.5v3.125h3.125M5.625 7.5a5 5 0 0 1 8.538-2.788L15 5.625m-.625 6.875A5 5 0 0 1 5.837 15.3L5 14.375" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ThreadsIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M5 5.625h10M5 10h10M5 14.375h6.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ViewIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M2.92 10c1.51-2.37 4.07-4.375 7.08-4.375 3.01 0 5.57 2.005 7.08 4.375-1.51 2.37-4.07 4.375-7.08 4.375-3.01 0-5.57-2.005-7.08-4.375Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.875 10a1.875 1.875 0 1 1-3.75 0 1.875 1.875 0 0 1 3.75 0Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PlayIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M7 5.625 14 10l-7 4.375V5.625Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ResumeIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M5 10a5 5 0 1 0 1.464-3.536L8.125 8.125" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 5.625V10h4.375" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SendIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="m3.75 10 11.875-5-3.75 10-1.875-3.125L3.75 10Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 11.875 15.625 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function RetryIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M15 7.5V4.375H11.875M5 12.5v3.125h3.125M5.625 7.5a5 5 0 0 1 8.538-2.788L15 5.625m-.625 6.875A5 5 0 0 1 5.837 15.3L5 14.375" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ClockIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="6.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 6.875V10l2.188 1.563" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LockIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M6.875 8.75V7.5a3.125 3.125 0 0 1 6.25 0v1.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="5" y="8.75" width="10" height="7.5" rx="1.75" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 11.875v1.875" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function WarningIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M10 4.375 16.25 15H3.75L10 4.375Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 8.125v3.75M10 14.375h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FileIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M6.25 3.75h5l2.5 2.5v10a1.25 1.25 0 0 1-1.25 1.25h-6.25A1.25 1.25 0 0 1 5 16.25V5A1.25 1.25 0 0 1 6.25 3.75Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.25 3.75V6.25H13.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.5 9.375h5M7.5 12.5h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FolderIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M3.75 6.25A1.25 1.25 0 0 1 5 5h3.125l1.25 1.25H15a1.25 1.25 0 0 1 1.25 1.25v6.25A1.25 1.25 0 0 1 15 15H5a1.25 1.25 0 0 1-1.25-1.25V6.25Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.75 8.125h12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SearchIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <circle cx="8.75" cy="8.75" r="4.375" stroke="currentColor" strokeWidth="1.5" />
      <path d="m11.875 11.875 3.75 3.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TimelineUserIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <circle cx="10" cy="7.5" r="2.75" stroke="currentColor" strokeWidth="1.45" />
      <path d="M4.75 15.75c.78-2.55 2.6-4 5.25-4s4.47 1.45 5.25 4" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TimelineRuntimeIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <rect x="3.75" y="4.75" width="12.5" height="10.5" rx="2" stroke="currentColor" strokeWidth="1.45" />
      <path d="m7 8.25 2 1.75-2 1.75M10.75 12h2.75" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TimelineAgentIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M6.25 7.35c0-1.1.9-2 2-2h3.5c1.1 0 2 .9 2 2v3.3c0 1.1-.9 2-2 2h-3.5c-1.1 0-2-.9-2-2v-3.3Z" stroke="currentColor" strokeWidth="1.35" />
      <path d="M8.55 8.75h.01M11.45 8.75h.01M8.75 10.9h2.5" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 5.35V3.75M5.35 10H3.75M16.25 10h-1.6M7.05 13.05 5.6 14.5M12.95 13.05l1.45 1.45" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <circle cx="10" cy="3.45" r=".8" fill="currentColor" />
      <circle cx="3.45" cy="10" r=".8" fill="currentColor" />
      <circle cx="16.55" cy="10" r=".8" fill="currentColor" />
    </svg>
  );
}

export function TimelineArtifactIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="m10 3.75 5.25 2.95v6.6L10 16.25 4.75 13.3V6.7L10 3.75Z" stroke="currentColor" strokeWidth="1.45" strokeLinejoin="round" />
      <path d="M4.95 6.85 10 9.8l5.05-2.95M10 9.8v6.2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TimelineDecisionIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M10 3.9 16.2 15H3.8L10 3.9Z" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 7.8v3.85M10 14h.01" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TimelineDelegationIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <circle cx="6" cy="6.75" r="2.1" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="14" cy="6.75" r="2.1" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="10" cy="14" r="2.1" stroke="currentColor" strokeWidth="1.4" />
      <path d="m7.65 8.1 1.35 3.7M12.35 8.1 11 11.8M8.1 6.75h3.8" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TimelineResultIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M6.2 7.6c0-1.1.9-2 2-2h3.2c1.1 0 2 .9 2 2v2.9c0 1.1-.9 2-2 2H8.2c-1.1 0-2-.9-2-2V7.6Z" stroke="currentColor" strokeWidth="1.35" />
      <path d="m8.15 9.65 1.45 1.35 2.65-3" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 5.4V3.75M7.05 13.05 5.6 14.5M12.95 13.05l1.45 1.45" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <circle cx="10" cy="3.45" r=".8" fill="currentColor" />
    </svg>
  );
}
