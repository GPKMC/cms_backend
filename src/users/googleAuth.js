// users/googleAuth.js
import express from 'express';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import jwt from 'jsonwebtoken';
import User from './user-model.js';

const googleAuthRouter = express.Router();

// Strategy: require verified email, exact match to DB, teacher/student only.
// Link googleId on first success and set isVerified=true.
passport.use(
  new GoogleStrategy(
    {
      clientID:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:  `${process.env.SERVER_URL || 'http://localhost:5000'}/api/auth/google/callback`,
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const googleEmail = profile?.emails?.[0]?.value?.toLowerCase().trim();
        const emailVerified = Boolean(profile?._json?.email_verified);

        if (!googleEmail || !emailVerified) {
          return done(null, false, { message: 'Use a verified Google account.' });
        }

        // Email must already exist (admin-provisioned)
        const user = await User.findOne({ email: googleEmail });
        if (!user) {
          return done(null, false, { message: 'Email not registered. Contact admin.' });
        }

        // Only students & teachers can use Google sign-in
        if (!['student', 'teacher'].includes(user.role)) {
          return done(null, false, { message: 'Google sign-in allowed for students/teachers only.' });
        }

        // Must be active
        if (user.isActive === false) {
          return done(null, false, { message: 'Your account is disabled. Contact administration.' });
        }

        // If already linked, enforce same Google account
        if (user.googleId && user.googleId !== profile.id) {
          return done(null, false, { message: 'This user is already linked to a different Google account.' });
        }

        // First successful link: set googleId and verify
        if (!user.googleId) {
          user.googleId = profile.id;
          user.isVerified = true;
          await user.save();
        }

        return done(null, user);
      } catch (err) {
        return done(err);
      }
    }
  )
);

// Required by Passport (we don't use persistent login sessions)
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => done(null, id));

// Start Google OAuth
googleAuthRouter.get(
  '/google',
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    state: true,              // enable CSRF state param
    prompt: 'select_account', // useful if multiple accounts are signed in
  })
);

// OAuth callback -> issue JWT -> redirect with hash token
googleAuthRouter.get(
  '/google/callback',
  passport.authenticate('google', {
    session: false,
    failureRedirect: `${process.env.CLIENT_URL}/login?error=google_auth_failed`,
  }),
  (req, res) => {
    const token = jwt.sign(
      { id: req.user._id, email: req.user.email, role: req.user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Use URL hash so token doesn't leak via referrer or server logs
    res.redirect(`${process.env.CLIENT_URL}/google-success#token=${token}`);

    // If you prefer httpOnly cookie instead, we can switch to res.cookie(...)
  }
);

export default googleAuthRouter;
