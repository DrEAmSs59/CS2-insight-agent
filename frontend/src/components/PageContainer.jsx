export default function PageContainer({ children, fullBleed = false, className = "" }) {
  if (fullBleed) return <div className={`page-container ${className}`}>{children}</div>;
  return (
    <div className={`page-container mx-auto flex h-full w-full max-w-[1600px] min-w-0 flex-col px-4 py-4 sm:px-6 sm:py-5 ${className}`}>
      {children}
    </div>
  );
}
