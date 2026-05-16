export default function PageContainer({ children, fullBleed = false, className = "" }) {
  if (fullBleed) return <div className={className}>{children}</div>;
  return (
    <div className={`mx-auto flex h-full w-full max-w-[1600px] flex-col px-6 py-5 sm:px-8 ${className}`}>
      {children}
    </div>
  );
}
