import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import * as recruiterNoteService from '../services/recruiterNote.service.js';

const listNotes = catchAsync(async (req, res) => {
  const notes = await recruiterNoteService.listForRecruiter(req.params.recruiterId, req.user);
  res.send({ results: notes });
});

const createNote = catchAsync(async (req, res) => {
  const note = await recruiterNoteService.createNote(req.params.recruiterId, req.user, {
    note: req.body.note,
    visibility: req.body.visibility,
  });
  res.status(httpStatus.CREATED).send(note);
});

const deleteNote = catchAsync(async (req, res) => {
  await recruiterNoteService.deleteNote(req.params.noteId, req.user);
  res.status(httpStatus.NO_CONTENT).send();
});

const shareByEmail = catchAsync(async (req, res) => {
  const result = await recruiterNoteService.shareRecruiterByEmail(
    req.params.recruiterId,
    { email: req.body.email, message: req.body.message },
    req.user
  );
  res.status(httpStatus.OK).send({
    success: true,
    message: 'Recruiter profile shared successfully',
    data: result,
  });
});

export { listNotes, createNote, deleteNote, shareByEmail };
