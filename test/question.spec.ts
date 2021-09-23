import 'mocha';
import { expect } from 'chai';
import { CUSTOMIZE, QuestionSpecification } from '../src/specification';
import { INVALID_IDS, VALID_IDS } from './common.spec';
import { Question } from '../src/exam_constructs';

export const MC_Basic : QuestionSpecification = {
  id: "question_id",
  points: 1,
  mk_description: "[description]",
  response: {
    kind: "multiple_choice",
    choices: ["choice1", "choice2", "choice3", "choice4", "choice5"],
    multiple: false
  }
};

describe('Question Specification', () => {

  it('Allows Valid Question IDs', () => {
    VALID_IDS.forEach(
      id => expect(() => Question.create(CUSTOMIZE(MC_Basic, {id: id}))).not.to.throw()
    );
  });

  it('Prohibits Invalid Question IDs', () => {
    INVALID_IDS.forEach(
      id => expect(() => Question.create(CUSTOMIZE(MC_Basic, {id: id}))).to.throw()
    );
  });

});