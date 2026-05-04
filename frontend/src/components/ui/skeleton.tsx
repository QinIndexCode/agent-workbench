interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className = '' }: SkeletonProps) {
  return (
    <div
      className={[
        'relative overflow-hidden rounded-md bg-surface-elevated',
        'before:absolute before:inset-0',
        'before:-translate-x-full before:animate-[shimmer_1.5s_infinite]',
        'before:bg-gradient-to-r before:from-transparent before:via-white/[0.06] before:to-transparent',
        className,
      ].join(' ')}
    />
  );
}
