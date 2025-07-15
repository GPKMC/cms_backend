import jwt from 'jsonwebtoken';

export const authmiddleware = (req, res, next) => {
  const { authorization } = req.headers;
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authorization header is missing' });
  }

  const token = authorization.split(' ')[1];  // ✅ This fixes your problem

  try {
    const userInfo = jwt.verify(token, process.env.JWT_SECRET);
    req.user = userInfo;
    console.log('Authenticated user:', req.user);
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid token' });
  }
};


export const authorizedRole = (...allowedroles)=>{
    return (req,res, next)=>{
        if(!req.user){
            return res.status(401).json({ message: 'User not authenticated' });
        }
        if(!allowedroles.includes(req.user.role)){
            return res.status(403).json({message:'Access forbidden : insufficient privileges'})
        }
next();
    }
}