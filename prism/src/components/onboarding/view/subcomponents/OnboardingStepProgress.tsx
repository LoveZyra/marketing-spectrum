import { Check, LogIn } from 'lucide-react';

type OnboardingStepProgressProps = {
  currentStep: number;
};

// Git identity used to be step 1 of 2. It configured `git config --global
// user.name/user.email` for a git surface that no longer exists, so onboarding
// is a single step now.
const onboardingSteps = [
  { title: 'Connect Agents', icon: LogIn, required: false },
];

export default function OnboardingStepProgress({ currentStep }: OnboardingStepProgressProps) {
  return (
    <div className="mb-5">
      <div className="flex items-center justify-between">
        {onboardingSteps.map((step, index) => {
          const isCompleted = index < currentStep;
          const isActive = index === currentStep;
          const Icon = step.icon;

          return (
            <div key={step.title} className="contents">
              <div className="flex flex-1 flex-col items-center">
                <div
                  className={`flex h-10 w-10 items-center justify-center rounded-full border-2 transition-all duration-200 ${
                    isCompleted
                      ? 'border-emerald-500 bg-emerald-500 text-white'
                      : isActive
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-card text-muted-foreground'
                  }`}
                >
                  {isCompleted ? <Check className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
                </div>
                <span
                  className={`mt-2 text-xs font-medium ${
                    isActive ? 'text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {step.title}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
