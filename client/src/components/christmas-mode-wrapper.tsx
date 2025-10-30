import { useQuery } from "@tanstack/react-query";
import { SnowAnimation } from "./snow-animation";

interface SystemSetting {
  key: string;
  value: string;
}

export function ChristmasModeWrapper() {
  const { data: settings } = useQuery<SystemSetting[]>({
    queryKey: ['/api/system-settings/public'],
    retry: false,
    staleTime: 60000,
  });

  const christmasModeEnabled = settings?.find(s => s.key === 'christmas_mode_enabled')?.value === 'true';

  if (!christmasModeEnabled) {
    return null;
  }

  return <SnowAnimation />;
}
