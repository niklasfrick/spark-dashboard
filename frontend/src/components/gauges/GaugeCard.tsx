import { MetricCard } from '@/components/MetricCard'

export function GaugeCard({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <MetricCard title={title} subtitle={subtitle}>
      <div className="flex flex-col items-center py-2">{children}</div>
    </MetricCard>
  )
}
