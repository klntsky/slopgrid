import { useId, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { Criterion } from "../../server/judge-criteria";
import { DeletableInput } from "./deletable-input";
import { ReorderHandle } from "./reorder-handle";
import "./criteria-editor.css";
import { tooltipRef } from "../components/use-tooltip";
import { ValidationFeedback, ValidationField } from "./validation-feedback";
import { VariableTokenPicker } from "./variable-input";

type Criteria = Criterion[];

export function CriteriaEditor({
  criteria,
  onChange,
  variables,
}: {
  criteria: Criteria;
  onChange: (criteria: Criteria) => void;
  variables: readonly string[];
}) {
  const root = useRef<HTMLTableElement>(null);
  const id = useId();
  const [dragging, setDragging] = useState<number>();
  const [dragTarget, setDragTarget] = useState<number>();

  function move(from: number, to: number) {
    if (to < 0 || to >= criteria.length || from === to) return;
    const next = [...criteria];
    next.splice(to, 0, ...next.splice(from, 1));
    onChange(next);
  }

  function dragChange(source?: number, target?: number) {
    setDragging(source);
    setDragTarget(target);
  }

  function update(index: number, change: Partial<Criteria[number]>) {
    onChange(
      criteria.map((criterion, position) =>
        position === index ? { ...criterion, ...change } : criterion,
      ),
    );
  }

  return (
    <div className="criteria-editor">
      <table className="criteria-table" ref={root}>
        <colgroup>
          <col className="criteria-handle-column" />
          <col />
          <col className="criteria-answer-column" />
        </colgroup>
        <tbody>
          {criteria.map((criterion, index) => (
            <tr
              className="criteria-row"
              data-dragging={dragging === index}
              data-insertion={
                dragTarget === index
                  ? "before"
                  : index === criteria.length - 1 &&
                      dragTarget === criteria.length
                    ? "after"
                    : undefined
              }
              key={index}
            >
              <td>
                <ReorderHandle
                  index={index}
                  label={`Move criterion ${index + 1}`}
                  root={root}
                  itemSelector=".criteria-row"
                  count={criteria.length}
                  onMove={move}
                  onDragChange={dragChange}
                />
              </td>
              <td>
                <ValidationField path={[index, "text"]}>
                  {(validation) => (
                    <DeletableInput
                      content={criterion.text}
                      label={`Remove criterion ${index + 1}`}
                      onRemove={() =>
                        onChange(
                          criteria.filter((_, position) => position !== index),
                        )
                      }
                    >
                      <textarea
                        aria-label={`Criterion ${index + 1}`}
                        id={`${id}-criterion-${index}`}
                        {...validation}
                        placeholder="a yes-or-no question about the output."
                        rows={1}
                        value={criterion.text}
                        onChange={(event) =>
                          update(index, { text: event.target.value })
                        }
                      />
                    </DeletableInput>
                  )}
                </ValidationField>
                <VariableTokenPicker
                  tokens={variables}
                  targetId={`${id}-criterion-${index}`}
                  value={criterion.text}
                  onChange={(text) => update(index, { text })}
                />
                <ValidationFeedback path={[index]} />
              </td>
              <td>
                <ValidationField path={[index, "correctAnswer"]}>
                  {(validation) => (
                    <button
                      type="button"
                      className="model-badge criteria-answer"
                      ref={tooltipRef}
                      data-tooltip={`Change the correct answer for criterion ${index + 1}`}
                      aria-label="Correct answer"
                      {...validation}
                      aria-pressed={criterion.correctAnswer}
                      onClick={() =>
                        update(index, {
                          correctAnswer: !criterion.correctAnswer,
                        })
                      }
                    >
                      {criterion.correctAnswer ? "YES" : "NO"}
                    </button>
                  )}
                </ValidationField>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        className="text-button criteria-add"
        ref={tooltipRef}
        data-tooltip="Add a criterion to this criteria list"
        onClick={() =>
          onChange([...criteria, { text: "", correctAnswer: true }])
        }
      >
        <Plus size={16} aria-hidden="true" />
        Add criterion
      </button>
      <ValidationFeedback />
    </div>
  );
}
