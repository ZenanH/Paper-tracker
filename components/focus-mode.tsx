'use client';

import { useEffect } from 'react';

export function FocusMode() {
  useEffect(() => {
    const root = document.documentElement;
    const setPointerMode = () => { root.dataset.focusMode = 'pointer'; };
    const setKeyboardMode = (event: KeyboardEvent) => {
      if (event.key === 'Tab' || event.key === 'F6') root.dataset.focusMode = 'keyboard';
    };

    document.addEventListener('pointerdown', setPointerMode, true);
    document.addEventListener('keydown', setKeyboardMode, true);
    return () => {
      document.removeEventListener('pointerdown', setPointerMode, true);
      document.removeEventListener('keydown', setKeyboardMode, true);
    };
  }, []);

  return null;
}
