/**
 * Portal-level loading fallback (Next 16 App Router `loading.tsx`).
 *
 * Renders while the async server component in `layout.tsx` (the session
 * read) is in flight. Matches the dark-mode background and a minimal
 * shimmer placeholder for the chrome shape (64px icon rail + 1fr main).
 *
 * Server component on purpose — keeps the very first paint small.
 */

export default function PortalLoading() {
  return (
    <div
      role="status"
      aria-label="Agentic Operator"
      style={{
        display: "grid",
        gridTemplateColumns: "64px minmax(0, 1fr)",
        height: "100vh",
        background: "var(--bg)",
        overflow: "hidden",
      }}
    >
      <aside
        style={{
          background: "var(--bg-2)",
          borderRight: "1px solid var(--border)",
          padding: "16px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <SkeletonBar w={28} h={28} />
        <SkeletonBar w={42} h={40} />
        <div style={{ marginTop: 12 }}>
          <SkeletonBar w={42} h={1} />
        </div>
        <SkeletonBar w={42} h={34} />
        <SkeletonBar w={42} h={34} />
        <SkeletonBar w={42} h={34} />
        <SkeletonBar w={42} h={34} />
      </aside>
      <main style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            height: 44,
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            padding: "0 18px",
            gap: 14,
          }}
        >
          <SkeletonBar w={120} h={14} />
          <div style={{ marginLeft: "auto" }} />
          <SkeletonBar w={240} h={26} />
        </div>
        <div style={{ flex: 1, padding: 20 }}>
          <SkeletonBar w={300} h={28} />
          <div
            style={{
              marginTop: 18,
              display: "grid",
              gridTemplateColumns: "repeat(5, 1fr)",
              gap: 12,
            }}
          >
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                style={{
                  height: 96,
                  border: "1px solid var(--border)",
                  background: "var(--panel)",
                  borderRadius: 8,
                }}
              />
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}

function SkeletonBar({ w, h }: { w: number; h: number }) {
  return (
    <div
      aria-hidden="true"
      style={{
        width: w,
        height: h,
        borderRadius: 4,
        background:
          "linear-gradient(90deg, var(--panel-2) 0%, var(--panel-3) 50%, var(--panel-2) 100%)",
        backgroundSize: "400px 100%",
        animation: "shimmer 1.4s linear infinite",
      }}
    />
  );
}
