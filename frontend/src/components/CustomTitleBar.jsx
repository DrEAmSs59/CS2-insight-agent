import React, { useState, useEffect } from 'react';
import { Minus, Square, X, Copy } from 'lucide-react';

export default function CustomTitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const isElectron = !!window.electron;

  useEffect(() => {
    if (isElectron) {
      window.electron.isMaximized().then(setIsMaximized);
      window.electron.onMaximizeChange((maximized) => {
        setIsMaximized(maximized);
      });
    }
  }, [isElectron]);

  if (!isElectron) {
    return null; // 如果不是在 electron 中则不渲染
  }

  return (
    <div 
      className="flex justify-between items-center w-full bg-[#111111] text-white z-50 shrink-0" 
      style={{ height: '50px', WebkitAppRegion: 'drag' }}
    >
      <div className="flex items-center px-4">
        <img src="/cs2-insight-logo.png" alt="Logo" className="w-6 h-6 mr-2" />
        <span className="font-semibold text-sm">CS2 Insight Agent</span>
      </div>
      
      <div className="flex h-full" style={{ WebkitAppRegion: 'no-drag' }}>
        <button 
          onClick={() => window.electron.minimize()} 
          className="flex items-center justify-center w-12 h-full hover:bg-white/10 transition-colors"
        >
          <Minus size={16} />
        </button>
        <button 
          onClick={() => window.electron.maximize()} 
          className="flex items-center justify-center w-12 h-full hover:bg-white/10 transition-colors"
        >
          {isMaximized ? <Copy size={14} /> : <Square size={14} />}
        </button>
        <button 
          onClick={() => window.electron.close()} 
          className="flex items-center justify-center w-12 h-full hover:bg-red-600 transition-colors"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
