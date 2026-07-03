import { X } from 'lucide-react';
import { useT } from '../i18n/useT';

export default function SponsorModal({ onClose }) {
  const t = useT();

  const handleBackdropClick = (e) => {
    // 只有点击背景层（不是模态框内容）才关闭
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div className="relative w-full max-w-md rounded-xl border border-cs2-border bg-cs2-bg-card p-6 shadow-xl">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 text-cs2-text-muted hover:text-cs2-text-primary transition-colors"
          aria-label={t("common.close")}
        >
          <X className="h-5 w-5" />
        </button>
        <h3 className="text-lg font-bold text-cs2-text-primary">
          {t("settings.sponsorTitle")}
        </h3>
        <p className="mt-2 text-xs text-cs2-text-muted">
          {t("settings.sponsorDesc")}
        </p>
        <div className="mt-4 flex justify-center gap-6">
          <div className="text-center">
            <img
              src="/asset/wx.jpg"
              alt={t("settings.sponsorWx")}
              className="h-48 w-48 rounded-lg border border-cs2-border object-cover"
            />
            <p className="mt-2 text-xs text-cs2-text-muted">
              {t("settings.sponsorWx")}
            </p>
          </div>
          <div className="text-center">
            <img
              src="/asset/ali.jpg"
              alt={t("settings.sponsorAli")}
              className="h-48 w-48 rounded-lg border border-cs2-border object-cover"
            />
            <p className="mt-2 text-xs text-cs2-text-muted">
              {t("settings.sponsorAli")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}