import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export function MetricCard({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <Card className="bg-[#0d0d10] border-white/[0.04]">
      <CardHeader className="pb-0 px-4 pt-3">
        <CardTitle className="text-sm font-semibold text-zinc-100">{title}</CardTitle>
        {subtitle && <p className="text-[11px] text-zinc-500 mt-0.5">{subtitle}</p>}
      </CardHeader>
      <CardContent className="space-y-2 pt-2 px-4 pb-3">
        {children}
      </CardContent>
    </Card>
  )
}
