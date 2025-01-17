import { readdirSync, readFileSync, copyFileSync, mkdirSync, existsSync, writeFileSync } from "fs";
import { ExamSubmission, fillManifest, TrustedExamSubmission } from "./core/submissions";
import Papa from "papaparse";
import { AssignedQuestion } from "./core/assigned_exams";
import path from "path";
import { asMutable, assert, assertNever } from "./core/util";
import { chunk } from "simple-statistics";
import { stringify_response } from "./response/responses";
import { GradingAssignmentSpecification } from "./grading_interface/common";
import { v4 as uuidv4, v5 as uuidv5} from 'uuid';

import glob from "glob";
import del from "del";
import "colors";

import { uniqueNamesGenerator, adjectives, colors, animals } from 'unique-names-generator';
import { ExamSpecification, StudentInfo } from "./core/exam_specification";
import { UUID_Strategy } from "./ExamGenerator";
import { ncp } from "ncp";
import { Exam, Question, Section } from "./core";

export namespace ExamUtils {

  export function loadExamSpecification(filename: string) : ExamSpecification {
    return JSON.parse(
      readFileSync(filename, "utf8"),
      (key: string, value: any) => {
        if (typeof value === "object" && typeof value["examma_ray_serialized_regex"] === "object") {
          return new RegExp(
            value["examma_ray_serialized_regex"]["source"],
            value["examma_ray_serialized_regex"]["flags"]
          );
        }
        return value;
      }
    );
  }

  export function saveExamSpecification(filename: string, spec: ExamSpecification) {
    writeFileSync(filename,
      JSON.stringify(
        spec,
        (key: string, value: any) => {
          if (value instanceof RegExp) {
            return {
              examma_ray_serialized_regex: {
                source: value.source,
                flags: value.flags
              }
            }
          }
          return value;
        },
        2
      )
    ,"utf8");
  }

  export function loadExamAnswers(filename: string) : ExamSubmission {
    return <ExamSubmission>JSON.parse(readFileSync(filename, "utf8"));
  }

  export function loadTrustedSubmission(manifestDirectory: string, submittedFilename: string) {
    let submitted = loadExamAnswers(submittedFilename);
    let manifest = loadExamAnswers(path.join(manifestDirectory, submitted.student.uniqname + "-" + submitted.uuid + ".json"))
    return fillManifest(
      manifest,
      submitted
    );
  }

  export function loadTrustedSubmissions(manifestDirectory: string, submittedDirectory: string) {
    
    let trustedAnswers : TrustedExamSubmission[] = [];
    readdirSync(submittedDirectory).forEach(
      filename => {
        try {
          let trustedSub = loadTrustedSubmission(
            manifestDirectory,
            path.join(submittedDirectory, filename)
          );
          trustedAnswers.push(trustedSub);
        }
        catch(e) {
          console.log("WARNING - unable to open submission file: " + filename);
        }
      }
    );
    return trustedAnswers;
  }

  export function loadCSVRoster(filename: string) {
    let students = Papa.parse<StudentInfo>(readFileSync(filename, "utf8"), {
      header: true,
      skipEmptyLines: true
    }).data;

    students.forEach(s => {
      assert(s.uniqname !== "", "Student uniqname may not be empty. Double check your roster file.");
      assert(s.name !== "", "Student name may not be empty. Double check your roster file.");
    })

    return students;
  }

  
  export function createGradingAssignments(aqs: readonly AssignedQuestion[], numChunks: number) : GradingAssignmentSpecification[] {
    assert(aqs.length > 0, "Cannot create grading assignments for an empty array of assigned questions.")
    let exam_id = aqs[0].exam.exam_id;
    let question_id = aqs[0].question.question_id;

    let initialAssn : GradingAssignmentSpecification = {
      exam_id: exam_id,
      question_id: question_id,
      groups: aqs.map((aq, i) => ({
        submissions: [{
          question_uuid: aq.uuid,
          skin_replacements: aq.skin.replacements,
          student: aq.student,
          response: stringify_response(aq.submission)
        }],
        name: "group_" + i,
        representative_index: 0,
        grading_result: undefined
      }))
    };

    return rechunkGradingAssignments([initialAssn], numChunks);
  }
  
  export function rechunkGradingAssignments(assns: GradingAssignmentSpecification[], numChunks: number) : GradingAssignmentSpecification[] {
    
    assert(assns.length > 0, "Grading assignments to rechunk must contain at least one assignment.");
    assert(Number.isInteger(numChunks), "Number of chunks must be an integer.");

    let { exam_id, question_id } = getAssnIds(assns);
    
    let groups = assns.flatMap(assn => assn.groups);
    groups.forEach((group, i) => group.name = `group_${i}`);

    let chunkSize = Math.ceil(groups.length / numChunks);

    let groupChunks = chunk(asMutable(groups), chunkSize);

    return groupChunks.map((c, i) => ({
      exam_id: exam_id,
      question_id: question_id,
      groups: c
    }));
  }

  export function gradingAssignmentDir(exam_id: string, question_id: string) {
    return `data/${exam_id}/manual_grading/${question_id}`;
  }

  /**
   * Loads any manual grading assignments (and results) for the given exam/question.
   * If there are no such results, returns an empty array.
   * @param exam_id 
   * @param question_id 
   * @returns 
   */
  export function readGradingAssignments(exam_id: string, question_id: string) {
    let files = glob.sync(`${gradingAssignmentDir(exam_id, question_id)}/*.json`);
    return files.map(filename => {
      let assn = <GradingAssignmentSpecification>JSON.parse(readFileSync(filename, "utf8"));
      if (!assn.name) {
        assn.name = path.basename(filename).replace(".json", "");
      }
      return assn;
    });
  }

  export function clearGradingAssignments(exam_id: string, question_id: string) {
    del.sync(`${gradingAssignmentDir(exam_id, question_id)}/*`);
  }

  export function writeGradingAssignments(assns: GradingAssignmentSpecification[]) {

    if (assns.length === 0) {
      return;
    }

    let { exam_id, question_id } = getAssnIds(assns);

    assns.forEach(assn => {
      let name = uniqueNamesGenerator({dictionaries: [adjectives, colors, animals], separator: "-"});
      let dir = gradingAssignmentDir(exam_id, question_id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        `${dir}/${name}.json`,
        JSON.stringify(Object.assign({}, assn, {name: name}), null, 2),
        { flag: "wx" } // Refuse to overwrite previous files (which could lose manual grading data)
      )
    });
  }

  export function writeExamMedia(media_out_dir: string, exam: Exam, all_sections: readonly Section[], all_questions: readonly Question[]) {
    
    // Copy overall exam media
    exam.media_dir && copyFrontendMedia(exam.media_dir, path.join(media_out_dir, "exam", exam.exam_id));

    // Copy media for all sections
    all_sections.forEach(
      s => s?.media_dir && copyFrontendMedia(s.media_dir, path.join(media_out_dir, "section", s.section_id))
    );

    // Copy media for all questions
    all_questions.forEach(
      q => q?.media_dir && copyFrontendMedia(q.media_dir, path.join(media_out_dir, "question", q.question_id))
    );
  }
}

function getAssnIds(assns: GradingAssignmentSpecification[]) {
  let exam_id = assns[0].exam_id;
  assert(assns.every(assn => assn.exam_id === exam_id), "All grading assignments to rechunk must have the same exam id.");

  let question_id = assns[0].question_id;
  assert(assns.every(assn => assn.question_id === question_id), "All grading assignments to rechunk must have the same question id.");
  return { exam_id, question_id };
}

export function writeFrontendJS(outDir: string, filename: string) {
  mkdirSync(outDir, { recursive: true });
  try {
    let path = require.resolve(`examma-ray/dist/frontend/${filename}`);
    copyFileSync(
      path,
      `${outDir}/${filename}`
    );
    console.log("Copied frontend JS bundle.")
  }
  catch(e: any) {
    if (e.code === "MODULE_NOT_FOUND") {

      try {
        copyFileSync(
          `../node_modules/examma-ray/dist/frontend/${filename}`,
          `${outDir}/${filename}`
        );
        console.log("Cannot resolve and copy frontend JS, using local copy instead.");
      }
      catch(e) {
        try {
          copyFileSync(
            `dist/frontend/${filename}`,
            `${outDir}/${filename}`
          );
          console.log("Cannot resolve and copy frontend JS, using local copy instead.");
        }
        catch(e) {
          console.log(`Failed to find and copy frontend JS: ${filename}`.red);
        }
      }
    }
    else {
      throw e;
    }
  }
}

export function copyFrontendMedia(media_source_dir: string, frontend_media_dir: string) {
  mkdirSync(frontend_media_dir, { recursive: true });

  ncp(
    media_source_dir,
    frontend_media_dir,
    (err) => { // callback
      if (!err) {
        console.log("Copied exam media.")
      }
      else {
        console.error("ERROR copying frontend media".red);
      }
    }
  )

}


/**
 * Takes an ID for an exam, section, or question and creates a uuid
 * for a particular student's instance of that entity. The uuid is
 * created based on the policy specified in the `ExamGenerator`'s
 * options when it is created.
 * @param student 
 * @param id 
 * @returns 
 */
export function createStudentUuid(options: {
  uuid_strategy: UUID_Strategy,
  uuidv5_namespace?: string,
}, student: StudentInfo, id: string) {
  if(options.uuid_strategy === "plain") {
    return student.uniqname + "-" + id;
  }
  else if (options.uuid_strategy === "uuidv4") {
    return uuidv4();
  }
  else if (options.uuid_strategy === "uuidv5") {
    assert(options.uuidv5_namespace);
    return uuidv5(student.uniqname + "-" + id, options.uuidv5_namespace!);
  }
  else {
    assertNever(options.uuid_strategy);
  }
}