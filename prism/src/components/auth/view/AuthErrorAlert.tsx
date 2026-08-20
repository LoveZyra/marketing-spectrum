import { AlertCircle } from 'lucide-react';

type AuthErrorAlertProps = {
  errorMessage: string;
};

export default function AuthErrorAlert({ errorMessage }: AuthErrorAlertProps) {
  if (!errorMessage) {
    return null;
  }

  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-md border border-border bg-card p-3 text-body"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <p className="text-sm leading-relaxed">{errorMessage}</p>
    </div>
  );
}
