import express from 'express';
import multer from 'multer';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as chatValidation from '../../validations/chat.validation.js';
import * as chatController from '../../controllers/chat.controller.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

router.use(auth(), requirePermissions('chats.read'));

router.get('/socket-token', chatController.getSocketToken);
router.get('/users/search', validate(chatValidation.searchUsers), chatController.searchUsers);

router.get('/conversations', validate(chatValidation.listConversations), chatController.listConversations);
router.post('/conversations', validate(chatValidation.createConversation), chatController.createConversation);

router.get('/conversations/:id', validate(chatValidation.conversationIdParam), chatController.getConversation);
router.patch(
  '/conversations/:id',
  validate(chatValidation.updateGroupName),
  chatController.updateGroupName
);
router.post(
  '/conversations/:id/participants',
  validate(chatValidation.addParticipants),
  chatController.addParticipants
);
router.delete(
  '/conversations/:id/participants/:userId',
  validate(chatValidation.removeParticipant),
  chatController.removeParticipant
);
router.patch(
  '/conversations/:id/participants/:userId/role',
  validate(chatValidation.setParticipantRole),
  chatController.setParticipantRole
);
router.get(
  '/conversations/:id/messages',
  validate(chatValidation.getMessages),
  chatController.getMessages
);
router.get(
  '/conversations/:id/calls',
  validate(chatValidation.conversationIdParam),
  chatController.listCallsForConversation
);
router.post(
  '/conversations/:id/messages',
  validate(chatValidation.sendMessage),
  chatController.sendMessage
);
router.delete(
  '/conversations/:id/messages/:msgId',
  validate(chatValidation.deleteMessage),
  chatController.deleteMessage
);
router.post(
  '/conversations/:id/messages/:msgId/react',
  validate(chatValidation.reactToMessage),
  chatController.reactToMessage
);
router.post(
  '/conversations/:id/messages/upload',
  validate(chatValidation.conversationIdParam),
  upload.array('files', 10),
  chatController.uploadAndSendMessage
);
router.patch(
  '/conversations/:id/read',
  validate(chatValidation.conversationIdParam),
  chatController.markAsRead
);
router.post(
  '/conversations/:id/call',
  validate(chatValidation.initiateCall),
  chatController.initiateCall
);

router.get('/calls', validate(chatValidation.listCalls), chatController.listCalls);
router.get(
  '/conversations/:id/active-call',
  validate(chatValidation.conversationIdParam),
  chatController.getActiveCallForConversation
);
router.patch(
  '/calls/:id',
  validate(chatValidation.updateCall),
  chatController.updateCall
);
router.post(
  '/calls/:id/recording/start',
  validate(chatValidation.startChatCallRecording),
  chatController.startChatCallRecording
);
router.post('/calls/end-by-room', chatController.endCallByRoom);

export default router;
