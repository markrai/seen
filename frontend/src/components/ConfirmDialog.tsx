import { Dialog, Transition } from '@headlessui/react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { Fragment, useEffect, useRef } from 'react';

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'default';
  preventAutoClose?: boolean; // If true, don't auto-close after confirm
}

export default function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'default',
  preventAutoClose = false,
}: ConfirmDialogProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  const handleConfirm = () => {
    onConfirm();
    if (!preventAutoClose) {
      onClose();
    }
  };

  // Headless UI Dialog's initialFocus prop handles focus automatically
  // But we'll also add a fallback in case the transition delays it
  useEffect(() => {
    if (isOpen && confirmButtonRef.current) {
      // Use requestAnimationFrame to ensure the dialog is fully rendered after transition
      const rafId = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          confirmButtonRef.current?.focus();
        });
      });
      return () => cancelAnimationFrame(rafId);
    }
  }, [isOpen]);

  return (
    <Transition show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={onClose} initialFocus={confirmButtonRef}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/30 dark:bg-black/50" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <Dialog.Panel className="w-full max-w-md transform overflow-hidden rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xl transition-all">
                <div className="p-6">
                  <div className="flex items-start gap-4">
                    {variant === 'danger' && (
                      <div className="flex-shrink-0">
                        <ExclamationTriangleIcon className="h-6 w-6 text-red-600 dark:text-red-400" />
                      </div>
                    )}
                    <div className="flex-1">
                      <Dialog.Title className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
                        {title}
                      </Dialog.Title>
                      <p className="text-sm text-zinc-600 dark:text-zinc-400">
                        {message}
                      </p>
                    </div>
                  </div>
                  <div className="mt-6 flex justify-end gap-3">
                    <button
                      onClick={onClose}
                      className="px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded-md transition-colors"
                    >
                      {cancelText}
                    </button>
                    <button
                      ref={confirmButtonRef}
                      onClick={handleConfirm}
                      tabIndex={0}
                      className={`px-4 py-2 text-sm font-medium text-white rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                        variant === 'danger'
                          ? 'bg-red-600 hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-600 focus:ring-red-500'
                          : 'bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 focus:ring-blue-500'
                      }`}
                    >
                      {confirmText}
                    </button>
                  </div>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}

