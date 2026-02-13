import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import Certificate from '../models/certificate.model.js';
import StudentCourseProgress from '../models/studentCourseProgress.model.js';
import TrainingModule from '../models/trainingModule.model.js';
import Student from '../models/student.model.js';
import StudentQuizAttempt from '../models/studentQuizAttempt.model.js';

/**
 * Generate certificate for student course completion
 * @param {ObjectId} studentId
 * @param {ObjectId} moduleId
 * @returns {Promise<Certificate>}
 */
const generateCertificate = async (studentId, moduleId) => {
  // Check if certificate already exists
  const existing = await Certificate.findOne({ student: studentId, module: moduleId });
  if (existing) {
    return existing;
  }
  
  // Get progress
  const progress = await StudentCourseProgress.findOne({ student: studentId, module: moduleId });
  if (!progress) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Course progress not found');
  }
  
  // Verify completion requirements
  if (progress.progress.percentage !== 100) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Course is not 100% complete');
  }
  
  if (progress.status !== 'completed') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Course is not marked as completed');
  }
  
  // Get module and student details
  const module = await TrainingModule.findById(moduleId);
  if (!module) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Training module not found');
  }
  
  const student = await Student.findById(studentId).populate('user', 'name email');
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }
  
  // Verify all quizzes are completed
  const quizItems = module.playlist.filter((item) => item.contentType === 'quiz');
  const completedQuizItems = progress.progress.completedItems.filter(
    (item) => item.contentType === 'quiz'
  );
  
  if (quizItems.length > 0 && completedQuizItems.length < quizItems.length) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'All quizzes must be completed before certificate can be issued'
    );
  }
  
  // Calculate final score (average of all quiz scores)
  const quizAttempts = await StudentQuizAttempt.find({
    student: studentId,
    module: moduleId,
    status: 'graded',
  });
  
  let finalScore = 0;
  if (quizAttempts.length > 0) {
    const totalScore = quizAttempts.reduce((sum, attempt) => sum + attempt.score.percentage, 0);
    finalScore = Math.round(totalScore / quizAttempts.length);
  } else {
    // If no quizzes, use 100% (all content completed)
    finalScore = 100;
  }
  
  // Create certificate
  const certificate = await Certificate.create({
    student: studentId,
    module: moduleId,
    studentName: student.user?.name || 'Student',
    courseName: module.moduleName,
    completionDate: progress.completedAt || new Date(),
    finalScore,
    // certificateUrl and certificateKey will be set when PDF/image is generated
    // For now, we'll leave them empty and they can be updated later
  });
  
  // Update progress with certificate info
  progress.certificate = {
    issued: true,
    issuedAt: certificate.issuedAt,
    certificateId: certificate.certificateId,
    certificateUrl: certificate.certificateUrl || '', // Will be updated when PDF is generated
  };
  await progress.save();
  
  return certificate;
};

/**
 * Get certificate for student course
 * @param {ObjectId} studentId
 * @param {ObjectId} moduleId
 * @returns {Promise<Certificate>}
 */
const getCertificate = async (studentId, moduleId) => {
  const certificate = await Certificate.findOne({ student: studentId, module: moduleId })
    .populate('student', 'user')
    .populate('module', 'moduleName');
  
  if (!certificate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Certificate not found');
  }
  
  return certificate;
};

/**
 * Verify certificate by verification code (public endpoint)
 * @param {string} verificationCode
 * @returns {Promise<Object>}
 */
const verifyCertificate = async (verificationCode) => {
  const certificate = await Certificate.findOne({ verificationCode })
    .populate('student', 'user')
    .populate('module', 'moduleName');
  
  if (!certificate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Certificate not found or invalid verification code');
  }
  
  return {
    valid: true,
    certificate: {
      certificateId: certificate.certificateId,
      studentName: certificate.studentName,
      courseName: certificate.courseName,
      completionDate: certificate.completionDate,
      finalScore: certificate.finalScore,
      issuedAt: certificate.issuedAt,
    },
  };
};

/**
 * Auto-generate certificate if conditions are met
 * Called after quiz submission or progress update
 * @param {ObjectId} studentId
 * @param {ObjectId} moduleId
 * @returns {Promise<Certificate|null>}
 */
const autoGenerateCertificateIfEligible = async (studentId, moduleId) => {
  try {
    const progress = await StudentCourseProgress.findOne({ student: studentId, module: moduleId });
    if (!progress) {
      return null;
    }
    
    // Check if already has certificate
    if (progress.certificate.issued) {
      return null;
    }
    
    // Check if 100% complete
    if (progress.progress.percentage !== 100) {
      return null;
    }
    
    // Check if all quizzes are completed
    const module = await TrainingModule.findById(moduleId);
    if (!module) {
      return null;
    }
    
    const quizItems = module.playlist.filter((item) => item.contentType === 'quiz');
    const completedQuizItems = progress.progress.completedItems.filter(
      (item) => item.contentType === 'quiz'
    );
    
    if (quizItems.length > 0 && completedQuizItems.length < quizItems.length) {
      return null; // Not all quizzes completed
    }
    
    // All conditions met - generate certificate
    return await generateCertificate(studentId, moduleId);
  } catch (error) {
    // Silently fail - certificate generation shouldn't break the main flow
    console.error('Auto-generate certificate error:', error);
    return null;
  }
};

export {
  generateCertificate,
  getCertificate,
  verifyCertificate,
  autoGenerateCertificateIfEligible,
};
