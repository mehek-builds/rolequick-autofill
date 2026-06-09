import React from 'react';

/** A single shimmering placeholder bar. */
export function SkeletonBar({
  width = '100%',
  height = 10,
  className = '',
}: {
  width?: number | string;
  height?: number;
  className?: string;
}) {
  return (
    <div
      className={`skeleton animate-shimmer rounded-md ${className}`}
      style={{ width, height }}
    />
  );
}

/** A contact-card-shaped skeleton: avatar circle + three text bars.
 *  Shown while contacts/drafts load. Never a blank popup, never a bare spinner. */
export function SkeletonContactCard() {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-3.5">
      <div className="flex items-start gap-3">
        <div className="skeleton animate-shimmer h-10 w-10 flex-shrink-0 rounded-full" />
        <div className="flex flex-1 flex-col gap-2 pt-0.5">
          <SkeletonBar width="60%" height={11} />
          <SkeletonBar width="85%" height={9} />
          <div className="mt-1 flex gap-1.5">
            <SkeletonBar width={54} height={16} className="!rounded-full" />
            <SkeletonBar width={66} height={16} className="!rounded-full" />
          </div>
        </div>
      </div>
      <SkeletonBar height={32} className="mt-3 !rounded-lg" />
    </div>
  );
}

/** A stack of contact-card skeletons with a soft staggered fade-in. */
export function SkeletonContactList({ count = 3 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="animate-fade-in-up"
          style={{ animationDelay: `${i * 70}ms` }}
        >
          <SkeletonContactCard />
        </div>
      ))}
    </div>
  );
}

/** Skeleton for the draft editor (subject line + body block). */
export function SkeletonDraft() {
  return (
    <div className="flex flex-col gap-3">
      <SkeletonBar width="30%" height={10} />
      <SkeletonBar height={38} className="!rounded-lg" />
      <SkeletonBar width="18%" height={10} className="mt-1" />
      <SkeletonBar height={150} className="!rounded-lg" />
    </div>
  );
}
