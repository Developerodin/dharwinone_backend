import catchAsync from '../utils/catchAsync.js';
import * as studentNoteService from '../services/studentNote.service.js';

const listNotes = catchAsync(async (req, res) => {
  const notes = await studentNoteService.listForStudent(req.params.studentId, req.user);
  res.send({ results: notes });
});

const createNote = catchAsync(async (req, res) => {
  const note = await studentNoteService.createNote(req.params.studentId, req.user, req.body);
  res.status(201).send(note);
});

const deleteNote = catchAsync(async (req, res) => {
  await studentNoteService.deleteNote(req.params.noteId, req.user);
  res.status(204).send();
});

export { listNotes, createNote, deleteNote };
