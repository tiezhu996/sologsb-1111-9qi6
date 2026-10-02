import { Tag, Tooltip } from 'antd';
import { gradeOf, RECOVERY_GRADE_TEXT } from '../../utils/recovery';
import type { RecoveryGrade } from '../../types/drill-run';

export interface RecoveryBadgeProps {
  /** 采取率（%） */
  recovery: number;
  showValue?: boolean;
  showAdvice?: boolean;
}

const GRADE_ICON: Record<RecoveryGrade, string> = { 优: '✔', 合格: '○', 异常: '⚠' };

/** 采取率分级标签（≥90 优 / 75-90 合格 / <75 异常），被工作台、回次记录页消费 */
export default function RecoveryBadge({ recovery, showValue = true, showAdvice = false }: RecoveryBadgeProps) {
  const grade = gradeOf(recovery);
  const text = RECOVERY_GRADE_TEXT[grade];
  const label = showValue ? `${grade} ${recovery}%` : grade;
  return (
    <Tooltip title={`${text.advice}${showAdvice ? '' : ''}`}>
      <Tag color={text.color}>
        {GRADE_ICON[grade]} {label}
      </Tag>
    </Tooltip>
  );
}
